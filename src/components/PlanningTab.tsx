'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { CheckCircle, Circle, Lock, AlertCircle, Loader2, X, ClipboardList } from 'lucide-react';

interface PlanningOption {
  id: string;
  label: string;
  /** When true, selecting this option reveals a free-text clarifier input so
   *  the user can add nuance alongside the choice (e.g. "Other: we use
   *  DocuSign" or "Option B, but with X"). */
  allow_details?: boolean;
}

interface PlanningQuestion {
  question: string;
  /** 'options' → multiple choice. 'freetext' → textarea only (no options). */
  input_kind?: 'options' | 'freetext';
  options: PlanningOption[];
  placeholder?: string;
}

interface PlanningMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface PlanningState {
  taskId: string;
  sessionKey?: string;
  messages: PlanningMessage[];
  currentQuestion?: PlanningQuestion;
  /** Planner declared clarify is done — either ready for research or ready
   *  to plan directly. UI renders an advance-phase screen here. */
  clarifyDone?: {
    understanding: string;
    unknowns: string[];
    needs_research: boolean;
    research_rationale?: string;
  };
  /** Server-side phase string, mirrors tasks.planning_phase. */
  phase?: 'clarify' | 'research' | 'plan' | 'confirm' | 'complete';
  isComplete: boolean;
  dispatchError?: string;
  parseError?: string;
  parseErrorContent?: string;
  spec?: {
    title: string;
    summary: string;
    // Old planner output is string[]; new structured output is objects. The
    // renderer below accepts both — old in-flight tasks still display.
    deliverables: Array<string | {
      id?: string;
      title: string;
      kind?: 'file' | 'behavior' | 'artifact';
      path_pattern?: string;
      acceptance?: string;
    }>;
    success_criteria: Array<string | {
      id?: string;
      assertion: string;
      how_to_test?: string;
    }>;
    constraints: Record<string, unknown>;
  };
  agents?: Array<{
    name: string;
    role: string;
    avatar_emoji: string;
    soul_md: string;
    instructions: string;
  }>;
  isStarted: boolean;
}

interface PlanningTabProps {
  taskId: string;
  onSpecLocked?: () => void;
}

export function PlanningTab({ taskId, onSpecLocked }: PlanningTabProps) {
  const [state, setState] = useState<PlanningState | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otherText, setOtherText] = useState('');
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);
  const [retryingDispatch, setRetryingDispatch] = useState(false);
  const [isSubmittingAnswer, setIsSubmittingAnswer] = useState(false);
  const [stalePlanning, setStalePlanning] = useState(false);
  const [forceCompleting, setForceCompleting] = useState(false);
  const [noNewMessageCount, setNoNewMessageCount] = useState(0);
  const [repromptingPlanner, setRepromptingPlanner] = useState(false);
  // Mid-flight state for the new user-gated phase transitions. 'research' /
  // 'plan' tell us which advance button the user just clicked; 'lock' drives
  // the Lock & Dispatch submit on the confirm screen.
  const [advancing, setAdvancing] = useState<null | 'research' | 'plan' | 'lock'>(null);
  // Add-clarification affordance on the clarify-done screen.
  const [addingClarification, setAddingClarification] = useState(false);
  const [clarificationText, setClarificationText] = useState('');
  const [submittingClarification, setSubmittingClarification] = useState(false);

  // Refs to track polling state without triggering re-renders
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollingWarningTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pollingHardTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isPollingRef = useRef(false);
  const lastSubmissionRef = useRef<{ answer: string; otherText?: string } | null>(null);
  const currentQuestionRef = useRef<string | undefined>(undefined);
  


  // Load planning state (initial load only)
  const loadState = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/planning`);
      if (res.ok) {
        const data = await res.json();
        setState(data);
        currentQuestionRef.current = data.currentQuestion?.question;
        // Don't call onSpecLocked on initial load - only when planning completes actively
      }
    } catch (err) {
      console.error('Failed to load planning state:', err);
      setError('Failed to load planning state');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  // Stop polling (defined first to avoid circular dependency)
  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    if (pollingWarningTimeoutRef.current) {
      clearTimeout(pollingWarningTimeoutRef.current);
      pollingWarningTimeoutRef.current = null;
    }
    if (pollingHardTimeoutRef.current) {
      clearTimeout(pollingHardTimeoutRef.current);
      pollingHardTimeoutRef.current = null;
    }
    setIsWaitingForResponse(false);
  }, []);

  // Poll for updates using the poll endpoint (lightweight OpenClaw check)
  const pollForUpdates = useCallback(async () => {
    if (isPollingRef.current) return; // Prevent overlapping polls
    isPollingRef.current = true;

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/poll`);
      if (res.ok) {
        const data = await res.json();

        // Track stale planning state from server
        if (data.stalePlanning) {
          setStalePlanning(true);
        }

        // Track consecutive "no updates" polls — if we get 15+ (30 seconds)
        // with no movement after submitting an answer, something is wrong
        if (!data.hasUpdates && isWaitingForResponse) {
          setNoNewMessageCount(prev => {
            const next = prev + 1;
            if (next >= 15) setStalePlanning(true);
            return next;
          });
        }

        // Surface malformed agent responses — this handles both the freshly-arrived
        // case (also returned with hasUpdates:true) and the already-stored case.
        if (data.parseError) {
          setError(null);
          setStalePlanning(false);
          setNoNewMessageCount(0);
          setRepromptingPlanner(false);
          setState(prev => prev ? { ...prev, parseError: data.parseError, parseErrorContent: data.rawContent } : prev);
          setIsWaitingForResponse(false);
          setIsSubmittingAnswer(false);
          setSubmitting(false);
          stopPolling();
          return;
        }

        // Auto-reprompt flow: the server sent a correction to the planner and
        // is waiting for a valid retry. Keep polling, show a transient banner.
        if (data.reprompted) {
          setError(null);
          setStalePlanning(false);
          setNoNewMessageCount(0);
          setRepromptingPlanner(true);
          return;
        }

        if (data.hasUpdates) {
          // Clear any stale waiting warnings once updates are flowing
          setError(null);
          setStalePlanning(false);
          setNoNewMessageCount(0);
          setRepromptingPlanner(false);

          const newQuestion = data.currentQuestion?.question;
          const questionChanged = newQuestion && currentQuestionRef.current !== newQuestion;

          // Force a full state reload from server to avoid stale state issues
          const freshRes = await fetch(`/api/tasks/${taskId}/planning`);
          if (freshRes.ok) {
            const freshData = await freshRes.json();
            setState(freshData);
          } else {
            setState(prev => ({
              ...prev!,
              messages: data.messages,
              isComplete: data.complete,
              spec: data.spec,
              agents: data.agents,
              currentQuestion: data.currentQuestion,
              dispatchError: data.dispatchError,
            }));
          }

          if (questionChanged) {
            currentQuestionRef.current = newQuestion;
            setSelectedOption(null);
            setOtherText('');
            setIsSubmittingAnswer(false);
          }
          // Always clear submitting state when we have a question
          if (data.currentQuestion) {
            setIsSubmittingAnswer(false);
            setSubmitting(false);
          }

          // Show dispatch error if present
          if (data.dispatchError) {
            setError(`Planning completed but dispatch failed: ${data.dispatchError}`);
          }

          if (data.complete && onSpecLocked) {
            onSpecLocked();
          }

          // Only stop polling when we actually have a question or completion
          if (data.currentQuestion || data.complete || data.dispatchError) {
            setIsWaitingForResponse(false);
            stopPolling();
          }
        }
      }
    } catch (err) {
      console.error('Failed to poll for updates:', err);
    } finally {
      isPollingRef.current = false;
    }
  }, [taskId, onSpecLocked, stopPolling, setState, setError, setIsSubmittingAnswer, setSelectedOption, setOtherText]);

  // Start polling when waiting for response
  const startPolling = useCallback(() => {
    stopPolling();
    setError(null);
    setIsWaitingForResponse(true);

    // Poll every 2 seconds for responsive UX
    pollingIntervalRef.current = setInterval(() => {
      pollForUpdates();
    }, 2000);

    // Soft warning at 90s, but keep polling so long responses can still complete
    pollingWarningTimeoutRef.current = setTimeout(() => {
      setError('The orchestrator is still processing. You can refresh safely — you will not lose your place in Planning Mode.');
    }, 90000);

    // Hard timeout at 5 minutes to avoid infinite wait states
    pollingHardTimeoutRef.current = setTimeout(() => {
      stopPolling();
      setSubmitting(false);
      setIsSubmittingAnswer(false);
      setError('The orchestrator timed out after an extended wait. Please refresh the page and retry your last answer.');
    }, 300000);
  }, [pollForUpdates, stopPolling]);

  // Update currentQuestion ref when state changes
  useEffect(() => {
    if (state?.currentQuestion) {
      currentQuestionRef.current = state.currentQuestion.question;
    }
  }, [state]);

  // Initial load
  useEffect(() => {
    loadState();
    return () => stopPolling();
  }, [loadState, stopPolling]);

  // Auto-start polling if planning is in progress but no question loaded yet
  useEffect(() => {
    // Only auto-poll when we're genuinely waiting on the planner. If the
    // planner already produced a clarify-done envelope or a plan, the UI
    // shows an explicit advance button and should NOT keep polling (that's
    // what triggered the stale "Planning appears stuck" banner when the
    // planner was happily sitting at confident: true).
    if (
      state &&
      state.isStarted &&
      !state.isComplete &&
      !state.currentQuestion &&
      !state.clarifyDone &&
      state.phase !== 'confirm' &&
      !isWaitingForResponse
    ) {
      startPolling();
    }
  }, [state, isWaitingForResponse, startPolling]);

  /**
   * User-gated phase transition. Sends an advance kickoff prompt to the
   * planner (research or plan) and starts polling for the response.
   */
  const advancePhase = async (to: 'research' | 'plan') => {
    setAdvancing(to);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to }),
      });
      if (res.ok) {
        // Clear the clarify-done block so we don't re-render the advance
        // buttons while the planner is producing its next envelope.
        setState(prev => (prev ? { ...prev, clarifyDone: undefined, phase: to } : prev));
        startPolling();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Failed to advance to ${to}`);
      }
    } catch {
      setError(`Failed to advance to ${to}`);
    } finally {
      setAdvancing(null);
    }
  };

  /**
   * User adds free-form clarification during clarify phase. Posts to
   * /clarify-add, then closes the inline form and polls for the planner's
   * revised envelope (which may be a new question or an updated confident
   * state).
   */
  const submitClarification = async () => {
    const text = clarificationText.trim();
    if (!text) return;
    setSubmittingClarification(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/clarify-add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clarification: text }),
      });
      if (res.ok) {
        // Clear clarifyDone so UI goes back to waiting state while the
        // planner integrates; the poll loop will render whatever comes back.
        setState(prev => (prev ? { ...prev, clarifyDone: undefined } : prev));
        setClarificationText('');
        setAddingClarification(false);
        startPolling();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to add clarification');
      }
    } catch {
      setError('Failed to add clarification');
    } finally {
      setSubmittingClarification(false);
    }
  };

  /**
   * Commit the confirm-phase spec: assigns agents, fires dispatch, moves the
   * task out of planning. This is the one place the spec leaves the confirm
   * gate — no other endpoint auto-dispatches anymore.
   */
  const lockAndDispatch = async () => {
    setAdvancing('lock');
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/lock`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        await loadState();
        if (onSpecLocked) onSpecLocked();
      } else {
        setError(data.error || 'Failed to lock plan');
      }
    } catch {
      setError('Failed to lock plan');
    } finally {
      setAdvancing(null);
    }
  };

  // Start planning session
  const startPlanning = async () => {
    setStarting(true);
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning`, { method: 'POST' });
      const data = await res.json();

      if (res.ok) {
        setState(prev => ({
          ...prev!,
          sessionKey: data.sessionKey,
          messages: data.messages || [],
          isStarted: true,
        }));

        // Start polling for the first question
        startPolling();
      } else {
        setError(data.error || 'Failed to start planning');
      }
    } catch (err) {
      setError('Failed to start planning');
    } finally {
      setStarting(false);
    }
  };

  // Submit answer
  const submitAnswer = async () => {
    const q = state?.currentQuestion;
    const isFreetext = q?.input_kind === 'freetext';

    // Guard: freetext requires non-empty text; options require a selection.
    if (isFreetext ? !otherText.trim() : !selectedOption) return;

    // When the selected option declared allow_details, the clarifier text is
    // required (same UX as the legacy "Other" field — empty is nonsensical).
    const selectedOpt = q?.options.find((o) => o.label === selectedOption);
    const needsClarifier = !!selectedOpt?.allow_details;
    if (needsClarifier && !otherText.trim()) return;

    setSubmitting(true);
    setIsSubmittingAnswer(true); // Show submitting state in UI
    setError(null);

    // Build submission payload. The /answer route treats answer='other' as
    // the text-only form and sends "Other: {otherText}" to the planner. For
    // the new allow_details flow we reuse that branch — "SelectedLabel: text"
    // reads naturally in the planner's chat history. Freetext sends just the
    // typed text with a generic 'other' answer so the existing server logic
    // composes the final message.
    let submission: { answer: string; otherText?: string };
    if (isFreetext) {
      submission = { answer: 'other', otherText: otherText.trim() };
    } else if (needsClarifier) {
      submission = { answer: 'other', otherText: `${selectedOption}: ${otherText.trim()}` };
    } else {
      submission = { answer: selectedOption! };
    }
    lastSubmissionRef.current = submission;

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
      });

      const data = await res.json();

      if (res.ok) {
        // Start polling for the next question or completion
        // Don't clear selection yet - keep it visible while waiting for response
        startPolling();
      } else {
        setError(data.error || 'Failed to submit answer');
        setIsSubmittingAnswer(false); // Clear submitting state on error
        // Clear selection on error so user can try again
        setSelectedOption(null);
        setOtherText('');
      }
    } catch (err) {
      setError('Failed to submit answer');
      setIsSubmittingAnswer(false); // Clear submitting state on error
      // Clear selection on error so user can try again
      setSelectedOption(null);
      setOtherText('');
    } finally {
      // Don't re-enable submit button here — wait until next question arrives
      // setSubmitting(false) is handled when polling gets the new question
    }
  };

  // Retry last submission
  const handleRetry = async () => {
    const submission = lastSubmissionRef.current;
    if (!submission) return;

    setSubmitting(true);
    setIsSubmittingAnswer(true); // Show submitting state
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
      });

      const data = await res.json();

      if (res.ok) {
        startPolling();
      } else {
        setError(data.error || 'Failed to submit answer');
        // Clear submission state and selection on error so user can retry
        setIsSubmittingAnswer(false);
        setSelectedOption(null);
        setOtherText('');
      }
    } catch (err) {
      setError('Failed to submit answer');
      // Clear submission state and selection on error so user can retry
      setIsSubmittingAnswer(false);
      setSelectedOption(null);
      setOtherText('');
    } finally {
      setSubmitting(false);
    }
  };

  // Retry dispatch for failed planning completions
  const retryDispatch = async () => {
    setRetryingDispatch(true);
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/retry-dispatch`, {
        method: 'POST',
      });

      const data = await res.json();

      if (res.ok) {
        console.log('Dispatch retry successful:', data.message);
        setError(null);
      } else {
        setError(`Failed to retry dispatch: ${data.error}`);
      }
    } catch (err) {
      setError('Failed to retry dispatch');
    } finally {
      setRetryingDispatch(false);
    }
  };

  // Force complete planning when stuck
  const forceCompletePlanning = async () => {
    setForceCompleting(true);
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/force-complete`, {
        method: 'POST',
      });

      const data = await res.json();

      if (res.ok) {
        setStalePlanning(false);
        setNoNewMessageCount(0);
        // Reload full state
        await loadState();
        if (onSpecLocked) onSpecLocked();
      } else {
        setError(data.error || 'Failed to force-complete planning');
      }
    } catch (err) {
      setError('Failed to force-complete planning');
    } finally {
      setForceCompleting(false);
    }
  };

  // Cancel planning
  const cancelPlanning = async () => {
    if (!confirm('Are you sure you want to cancel planning? This will reset the planning state.')) {
      return;
    }

    setCanceling(true);
    setError(null);
    setIsSubmittingAnswer(false); // Clear submitting state when canceling
    stopPolling(); // Stop polling when canceling

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning`, {
        method: 'DELETE',
      });

      if (res.ok) {
        // Reset state
        setState({
          taskId,
          isStarted: false,
          messages: [],
          isComplete: false,
        });
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to cancel planning');
      }
    } catch (err) {
      setError('Failed to cancel planning');
    } finally {
      setCanceling(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-6 h-6 animate-spin text-mc-accent" />
        <span className="ml-2 text-mc-text-secondary">Loading planning state...</span>
      </div>
    );
  }

  // Planning complete - show spec and agents
  if (state?.isComplete && state?.spec) {
    return (
      <div className="p-4 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-green-400">
            <Lock className="w-5 h-5" />
            <span className="font-medium">Planning Complete</span>
          </div>
          {state.dispatchError && (
            <div className="text-right">
              <span className="text-sm text-amber-400">⚠️ Dispatch Failed</span>
            </div>
          )}
        </div>
        
        {/* Dispatch Error with Retry */}
        {state.dispatchError && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="text-amber-400 text-sm font-medium mb-2">Task dispatch failed</p>
                <p className="text-amber-300 text-xs mb-3">{state.dispatchError}</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={retryDispatch}
                    disabled={retryingDispatch}
                    className="px-3 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs rounded-sm disabled:opacity-50 flex items-center gap-1"
                  >
                    {retryingDispatch ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Retrying...
                      </>
                    ) : (
                      <>
                        <CheckCircle className="w-3 h-3" />
                        Retry Dispatch
                      </>
                    )}
                  </button>
                  <span className="text-amber-400 text-xs">
                    This will attempt to assign the task to an agent
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
        
        {/* Spec Summary */}
        <div className="bg-mc-bg border border-mc-border rounded-lg p-4">
          <h3 className="font-medium mb-2">{state.spec.title}</h3>
          <p className="text-sm text-mc-text-secondary mb-4">{state.spec.summary}</p>
          
          {state.spec.deliverables?.length > 0 && (
            <div className="mb-3">
              <h4 className="text-sm font-medium mb-1">Deliverables:</h4>
              <ul className="list-disc list-inside text-sm text-mc-text-secondary space-y-1">
                {state.spec.deliverables.map((d, i) => {
                  if (typeof d === 'string') {
                    return <li key={i}>{d}</li>;
                  }
                  return (
                    <li key={d.id || i}>
                      <span className="font-medium text-mc-text">{d.title}</span>
                      {d.kind ? <span className="text-xs text-mc-text-tertiary"> ({d.kind})</span> : null}
                      {d.path_pattern ? <code className="ml-1 text-xs text-mc-accent">{d.path_pattern}</code> : null}
                      {d.acceptance ? <div className="text-xs ml-5 text-mc-text-tertiary">{d.acceptance}</div> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {state.spec.success_criteria?.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-1">Success Criteria:</h4>
              <ul className="list-disc list-inside text-sm text-mc-text-secondary space-y-1">
                {state.spec.success_criteria.map((c, i) => {
                  if (typeof c === 'string') {
                    return <li key={i}>{c}</li>;
                  }
                  return (
                    <li key={c.id || i}>
                      <span>{c.assertion}</span>
                      {c.how_to_test ? <div className="text-xs ml-5 text-mc-text-tertiary">Test: {c.how_to_test}</div> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
        
        {/* Generated Agents */}
        {state.agents && state.agents.length > 0 && (
          <div>
            <h3 className="font-medium mb-2">Agents Created:</h3>
            <div className="space-y-2">
              {state.agents.map((agent, i) => (
                <div key={i} className="bg-mc-bg border border-mc-border rounded-lg p-3 flex items-center gap-3">
                  <span className="text-2xl">{agent.avatar_emoji}</span>
                  <div>
                    <p className="font-medium">{agent.name}</p>
                    <p className="text-sm text-mc-text-secondary">{agent.role}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Not started - show start button
  if (!state?.isStarted) {
    return (
      <div className="flex flex-col items-center justify-center p-8 space-y-4">
        <div className="text-center">
          <h3 className="text-lg font-medium mb-2">Start Planning</h3>
          <p className="text-mc-text-secondary text-sm max-w-md">
            I&apos;ll ask you a few questions to understand exactly what you need. 
            All questions are multiple choice — just click to answer.
          </p>
        </div>
        
        {error && (
          <div className="flex items-center gap-2 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4" />
            {error}
          </div>
        )}
        
        <button
          onClick={startPlanning}
          disabled={starting}
          className="px-6 py-3 bg-mc-accent text-mc-bg rounded-lg font-medium hover:bg-mc-accent/90 disabled:opacity-50 flex items-center gap-2"
        >
          {starting ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Starting...
            </>
          ) : (
            <>📋 Start Planning</>
          )}
        </button>
      </div>
    );
  }

  // Show current question
  return (
    <div className="flex flex-col h-full">
      {/* Progress indicator with cancel button */}
      <div className="p-4 border-b border-mc-border flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-mc-text-secondary">
          <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse" />
          <span>Planning in progress...</span>
        </div>
        <button
          onClick={cancelPlanning}
          disabled={canceling}
          className="flex items-center gap-2 px-3 py-2 text-sm text-mc-accent-red hover:bg-mc-accent-red/10 rounded-sm disabled:opacity-50"
        >
          {canceling ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Canceling...
            </>
          ) : (
            <>
              <X className="w-4 h-4" />
              Cancel
            </>
          )}
        </button>
      </div>

      {/* Auto-reprompt in-flight — planner emitted invalid JSON, server asked it to reformat */}
      {repromptingPlanner && !state?.parseError && (
        <div className="mx-4 mt-4 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-amber-400 shrink-0" />
            <p className="text-amber-300 text-xs">
              Planner returned invalid JSON — asked it to reformat. Waiting for corrected response…
            </p>
          </div>
        </div>
      )}

      {/* Parse error banner — agent emitted unparseable JSON */}
      {state?.parseError && (
        <div className="mx-4 mt-4 bg-red-500/10 border border-red-500/30 rounded-lg p-4">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-red-400 text-sm font-medium mb-2">Malformed response from planner</p>
              <p className="text-red-300 text-xs mb-3">{state.parseError}</p>
              {state.parseErrorContent && (
                <details className="mb-3">
                  <summary className="text-red-400 text-xs cursor-pointer hover:text-red-300">
                    Show raw content
                  </summary>
                  <pre className="mt-2 p-2 bg-black/40 border border-red-500/20 rounded text-xs text-red-200 overflow-x-auto whitespace-pre-wrap break-words max-h-64">
{state.parseErrorContent}
                  </pre>
                </details>
              )}
              <button
                onClick={cancelPlanning}
                disabled={canceling}
                className="px-3 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 text-xs rounded-sm disabled:opacity-50"
              >
                Cancel planning and retry
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Question area */}
      <div className="flex-1 overflow-y-auto p-6">
        {state?.currentQuestion ? (
          <div className="max-w-xl mx-auto">
            <h3 className="text-lg font-medium mb-6">
              {state.currentQuestion.question}
            </h3>

            {state.currentQuestion.input_kind === 'freetext' ? (
              // Freetext shape: no options, just a textarea. Planner used
              // this when the answer space was too broad for multiple choice.
              <div>
                <textarea
                  value={otherText}
                  onChange={(e) => setOtherText(e.target.value)}
                  placeholder={state.currentQuestion.placeholder || 'Type your answer…'}
                  rows={5}
                  className="w-full bg-mc-bg border border-mc-border rounded-lg px-3 py-2 text-sm focus:outline-hidden focus:border-mc-accent"
                  disabled={submitting}
                  autoFocus
                />
              </div>
            ) : (
              <div className="space-y-3">
                {state.currentQuestion.options.map((option) => {
                  const isSelected = selectedOption === option.label;
                  // The planner can opt any option into a clarifier input by
                  // setting allow_details:true. We also treat a literal
                  // "Other" as allow_details so legacy envelopes keep working.
                  const isOtherByConvention =
                    option.id === 'other' || option.label.toLowerCase() === 'other';
                  const showClarifier = !!option.allow_details || isOtherByConvention;
                  const isThisOptionSubmitting = isSubmittingAnswer && isSelected;

                  return (
                    <div key={option.id}>
                      <button
                        onClick={() => {
                          setSelectedOption(option.label);
                          // Clear stale clarifier when switching between
                          // allow_details options so we don't send old text.
                          setOtherText('');
                        }}
                        disabled={submitting}
                        className={`w-full flex items-center gap-3 p-4 rounded-lg border transition-all text-left ${
                          isThisOptionSubmitting
                            ? 'border-mc-accent bg-mc-accent/20'
                            : isSelected
                            ? 'border-mc-accent bg-mc-accent/10'
                            : 'border-mc-border hover:border-mc-accent/50'
                        } disabled:opacity-50`}
                      >
                        <span className={`w-8 h-8 rounded flex items-center justify-center text-sm font-bold ${
                          isSelected ? 'bg-mc-accent text-mc-bg' : 'bg-mc-bg-tertiary'
                        }`}>
                          {option.id.toUpperCase()}
                        </span>
                        <span className="flex-1">{option.label}</span>
                        {isThisOptionSubmitting ? (
                          <Loader2 className="w-5 h-5 text-mc-accent animate-spin" />
                        ) : isSelected && !submitting ? (
                          <CheckCircle className="w-5 h-5 text-mc-accent" />
                        ) : null}
                      </button>

                      {/* Clarifier text input — shown when the selected
                          option opted in via allow_details (or it's "Other"). */}
                      {showClarifier && isSelected && (
                        <div className="mt-2 ml-11">
                          <input
                            type="text"
                            value={otherText}
                            onChange={(e) => setOtherText(e.target.value)}
                            placeholder={
                              state.currentQuestion?.placeholder ||
                              (isOtherByConvention ? 'Please specify…' : 'Add details…')
                            }
                            className="w-full bg-mc-bg border border-mc-border rounded-sm px-3 py-2 text-sm focus:outline-hidden focus:border-mc-accent"
                            disabled={submitting}
                            autoFocus
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {error && (
              <div
                className={`mt-4 p-3 border rounded-lg ${
                  error.includes('still processing')
                    ? 'bg-orange-500/10 border-orange-500/40'
                    : 'bg-red-500/10 border-red-500/30'
                }`}
              >
                <div className="flex items-start gap-2">
                  <AlertCircle
                    className={`w-4 h-4 mt-0.5 shrink-0 ${
                      error.includes('still processing') ? 'text-orange-300' : 'text-red-400'
                    }`}
                  />
                  <div className="flex-1">
                    <p className={`text-sm ${error.includes('still processing') ? 'text-orange-200' : 'text-red-400'}`}>
                      {error}
                    </p>
                    {!isWaitingForResponse && lastSubmissionRef.current && (
                      <button
                        onClick={handleRetry}
                        disabled={submitting}
                        className={`mt-2 text-xs underline disabled:opacity-50 ${
                          error.includes('still processing')
                            ? 'text-orange-300 hover:text-orange-200'
                            : 'text-red-400 hover:text-red-300'
                        }`}
                      >
                        {submitting ? 'Retrying...' : 'Retry'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Submit button */}
            <div className="mt-6">
              {(() => {
                const q = state.currentQuestion;
                const isFreetext = q?.input_kind === 'freetext';
                const selectedOpt = q?.options.find((o) => o.label === selectedOption);
                const isOtherByConvention =
                  !!selectedOpt && (selectedOpt.id === 'other' || selectedOpt.label.toLowerCase() === 'other');
                const needsClarifier = !!selectedOpt?.allow_details || isOtherByConvention;
                const canSubmit = isFreetext
                  ? otherText.trim().length > 0
                  : !!selectedOption && (!needsClarifier || otherText.trim().length > 0);
                return (
              <button
                onClick={submitAnswer}
                disabled={!canSubmit || submitting}
                className="w-full px-6 py-3 bg-mc-accent text-mc-bg rounded-lg font-medium hover:bg-mc-accent/90 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Sending...
                  </>
                ) : (
                  'Continue →'
                )}
              </button>
                );
              })()}

              {/* Waiting indicator after submit */}
              {isSubmittingAnswer && !submitting && (
                <div className="mt-4 flex items-center justify-center gap-2 text-sm text-mc-text-secondary">
                  <Loader2 className="w-4 h-4 animate-spin text-mc-accent" />
                  <span>Waiting for response...</span>
                </div>
              )}
            </div>
          </div>
        ) : state?.clarifyDone ? (
          // Clarify phase done — planner has a confident understanding and
          // told us whether research would close remaining unknowns. Show an
          // advance-phase screen with Start research / Continue to plan.
          <div className="max-w-2xl mx-auto p-6">
            <div className="mb-6">
              <div className="flex items-center gap-2 text-mc-accent mb-2">
                <CheckCircle className="w-5 h-5" />
                <span className="font-medium text-sm uppercase tracking-wide">Clarify phase complete</span>
              </div>
              <h3 className="text-lg font-medium mb-2">Here&apos;s what I understand</h3>
              <p className="text-sm text-mc-text-secondary leading-relaxed">
                {state.clarifyDone.understanding}
              </p>
            </div>

            {state.clarifyDone.unknowns.length > 0 && (
              <div className="mb-6 bg-mc-bg border border-mc-border rounded-lg p-4">
                <p className="text-xs uppercase tracking-wide text-mc-text-secondary mb-2">Open unknowns</p>
                <ul className="list-disc list-inside text-sm space-y-1">
                  {state.clarifyDone.unknowns.map((u, i) => (
                    <li key={i} className="text-mc-text-secondary">{u}</li>
                  ))}
                </ul>
              </div>
            )}

            {state.clarifyDone.needs_research && state.clarifyDone.research_rationale && (
              <div className="mb-6 bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
                <p className="text-xs uppercase tracking-wide text-blue-300 mb-2">Why research?</p>
                <p className="text-sm text-blue-200">{state.clarifyDone.research_rationale}</p>
              </div>
            )}

            {/* Add clarification — user can inject additional context the
                planner didn't ask about (e.g. "sales are through app stores,
                matters for nexus"). Sends to /clarify-add and waits for the
                planner's revised envelope. */}
            <div className="mb-6 bg-mc-bg border border-mc-border rounded-lg">
              {addingClarification ? (
                <div className="p-4 space-y-3">
                  <p className="text-xs uppercase tracking-wide text-mc-text-secondary">Add clarification</p>
                  <textarea
                    value={clarificationText}
                    onChange={(e) => setClarificationText(e.target.value)}
                    placeholder="Anything the planner missed? e.g. sales model, infra constraints, compliance context…"
                    rows={3}
                    autoFocus
                    disabled={submittingClarification}
                    className="w-full bg-mc-bg-secondary border border-mc-border rounded-sm px-3 py-2 text-sm focus:outline-hidden focus:border-mc-accent resize-y"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={submitClarification}
                      disabled={submittingClarification || !clarificationText.trim()}
                      className="px-4 py-2 bg-mc-accent text-mc-bg text-sm rounded-lg font-medium hover:bg-mc-accent/90 disabled:opacity-50 flex items-center gap-2"
                    >
                      {submittingClarification ? (
                        <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</>
                      ) : (
                        'Send clarification'
                      )}
                    </button>
                    <button
                      onClick={() => { setAddingClarification(false); setClarificationText(''); }}
                      disabled={submittingClarification}
                      className="px-4 py-2 text-sm text-mc-text-secondary hover:text-mc-text rounded-lg"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setAddingClarification(true)}
                  disabled={!!advancing}
                  className="w-full p-3 text-sm text-mc-text-secondary hover:text-mc-accent flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  + Add clarification (e.g. extra context the planner missed)
                </button>
              )}
            </div>

            <div className="flex flex-col gap-3">
              {state.clarifyDone.needs_research && (
                <button
                  onClick={() => advancePhase('research')}
                  disabled={!!advancing}
                  className="w-full px-6 py-3 bg-mc-accent text-mc-bg rounded-lg font-medium hover:bg-mc-accent/90 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {advancing === 'research' ? (
                    <><Loader2 className="w-5 h-5 animate-spin" /> Starting research…</>
                  ) : (
                    <>🔎 Start research</>
                  )}
                </button>
              )}
              <button
                onClick={() => advancePhase('plan')}
                disabled={!!advancing}
                className={`w-full px-6 py-3 rounded-lg font-medium disabled:opacity-50 flex items-center justify-center gap-2 ${
                  state.clarifyDone.needs_research
                    ? 'bg-mc-bg border border-mc-border hover:border-mc-accent'
                    : 'bg-mc-accent text-mc-bg hover:bg-mc-accent/90'
                }`}
              >
                {advancing === 'plan' ? (
                  <><Loader2 className="w-5 h-5 animate-spin" /> Building plan…</>
                ) : state.clarifyDone.needs_research ? (
                  'Skip research → go straight to plan'
                ) : (
                  'Continue to plan →'
                )}
              </button>
            </div>

            {error && (
              <div className="mt-4 p-3 border border-red-500/30 bg-red-500/10 rounded-lg flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}
          </div>
        ) : state?.phase === 'confirm' && state.spec ? (
          // Plan arrived from the planner — show the spec read-only and gate
          // dispatch behind Lock & Dispatch. Tweak chat is a follow-up
          // iteration; for now the user can Cancel if they want to revise.
          <div className="max-w-2xl mx-auto p-6 space-y-4">
            <div className="flex items-center gap-2 text-mc-accent">
              <ClipboardList className="w-5 h-5" />
              <span className="font-medium text-sm uppercase tracking-wide">Plan ready — review before dispatch</span>
            </div>
            <div className="bg-mc-bg border border-mc-border rounded-lg p-4">
              <h3 className="font-medium mb-2">{state.spec.title}</h3>
              <p className="text-sm text-mc-text-secondary mb-4">{state.spec.summary}</p>
              {state.spec.deliverables?.length > 0 && (
                <>
                  <p className="text-xs uppercase tracking-wide text-mc-text-secondary mb-2">Deliverables</p>
                  <ul className="list-disc list-inside text-sm space-y-1 mb-4">
                    {state.spec.deliverables.map((d, i) => {
                      if (typeof d === 'string') return <li key={i}>{d}</li>;
                      return (
                        <li key={d.id || i}>
                          <span className="font-medium">{d.title}</span>
                          {d.path_pattern ? <code className="ml-1 text-xs text-mc-accent">{d.path_pattern}</code> : null}
                          {d.acceptance ? <div className="text-xs ml-5 text-mc-text-tertiary">{d.acceptance}</div> : null}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
              {state.spec.success_criteria?.length > 0 && (
                <>
                  <p className="text-xs uppercase tracking-wide text-mc-text-secondary mb-2">Success criteria</p>
                  <ul className="list-disc list-inside text-sm space-y-1">
                    {state.spec.success_criteria.map((c, i) => {
                      if (typeof c === 'string') return <li key={i}>{c}</li>;
                      return (
                        <li key={c.id || i}>
                          <span>{c.assertion}</span>
                          {c.how_to_test ? <div className="text-xs ml-5 text-mc-text-tertiary">Test: {c.how_to_test}</div> : null}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
            <button
              onClick={lockAndDispatch}
              disabled={!!advancing}
              className="w-full px-6 py-3 bg-mc-accent text-mc-bg rounded-lg font-medium hover:bg-mc-accent/90 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {advancing === 'lock' ? (
                <><Loader2 className="w-5 h-5 animate-spin" /> Locking &amp; dispatching…</>
              ) : (
                <><Lock className="w-5 h-5" /> Lock &amp; Dispatch</>
              )}
            </button>
            {error && (
              <div className="p-3 border border-red-500/30 bg-red-500/10 rounded-lg flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}
          </div>
        ) : state?.parseError ? null : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              {stalePlanning ? (
                <>
                  <AlertCircle className="w-8 h-8 text-amber-400 mx-auto mb-3" />
                  <p className="text-amber-300 font-medium mb-2">Planning appears stuck</p>
                  <p className="text-mc-text-secondary text-sm mb-4 max-w-sm">
                    The orchestrator hasn&apos;t responded in a while. This can happen when the completion message was processed but the dispatch didn&apos;t fire.
                  </p>
                  <div className="flex items-center justify-center gap-3">
                    <button
                      onClick={forceCompletePlanning}
                      disabled={forceCompleting}
                      className="px-4 py-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-sm rounded-lg border border-amber-500/30 disabled:opacity-50 flex items-center gap-2"
                    >
                      {forceCompleting ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Processing...
                        </>
                      ) : (
                        <>
                          <CheckCircle className="w-4 h-4" />
                          Force Complete &amp; Dispatch
                        </>
                      )}
                    </button>
                    <button
                      onClick={cancelPlanning}
                      disabled={canceling}
                      className="px-4 py-2 text-mc-text-secondary hover:text-mc-accent-red text-sm rounded-lg border border-mc-border hover:border-mc-accent-red/30"
                    >
                      Cancel Planning
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <Loader2 className="w-8 h-8 animate-spin text-mc-accent mx-auto mb-2" />
                  <p className="text-mc-text-secondary">
                    {isWaitingForResponse ? 'Waiting for response...' : 'Waiting for next question...'}
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Conversation history (collapsed by default) */}
      {state?.messages && state.messages.length > 0 && (
        <details className="border-t border-mc-border">
          <summary className="p-3 text-sm text-mc-text-secondary cursor-pointer hover:bg-mc-bg-tertiary">
            View conversation ({state.messages.length} messages)
          </summary>
          <div className="p-3 space-y-2 max-h-48 overflow-y-auto bg-mc-bg">
            {state.messages.map((msg, i) => (
              <div key={i} className={`text-sm ${msg.role === 'user' ? 'text-mc-accent' : 'text-mc-text-secondary'}`}>
                <span className="font-medium">{msg.role === 'user' ? 'You' : 'Orchestrator'}:</span>{' '}
                <span className="opacity-75">{msg.content.substring(0, 100)}...</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
