## INITIATIVE 1 - Smart Snappy - EPIC

Smart Snappy turns the SnapCalorie assistant from a passive meal-logging chatbot into a proactive, personalized coach that guides users toward their health goals.

## What it includes

- **Snappy Service backend (TBD how stateless functions hold context)** — a layer that compiles user activity, goals, and recent responses, then prompts an AI model and returns structured actions (checklist items, tips, meal suggestions, notifications).
- **Memory + personalization** — store loose user-context JSON the AI can read/write across sessions. Probably Firebase to start? May need a stricter schema later.
- **Onboarding flow** — Snappy interviews the user about goals, preferences, constraints, cooking habits, and schedule, then writes the baseline memory.
- **Daily / weekly checklist** — adaptive list tied to user goals (protein, fiber, hydration, mood support, etc.).
- **Meal & snack suggestions** — pulled from remaining macro targets and known deficiencies; optional grocery integration (later).
- **Dashboard cards** — render whatever Snappy returns: checklist card, snack suggestion, goal nudge, recipe, grocery list. ??? — exact card schema not yet decided.
- **Conversational UI** — let users talk back to Snappy beyond just Q&A. RN voice? Floating button? Clippy-style? — open question.
- **Advanced goals** (later) — fertility, pregnancy, cycle, sleep, stress.

## Acceptance

Users can complete onboarding, see a daily checklist on the home dashboard, get at least one meal suggestion per day, and have a back-and-forth conversation with Snappy that references their stored preferences. Internal team can ship a v0 in ~6-8 weeks with one backend engineer and one mobile engineer.

## Open questions

- How do we keep prompts cheap when running daily for every user?
- Do notifications go through the existing push system or a new channel?
- What's the migration path from the current chatbot UI?

## REFINE WITH PM GUIDANCE

Refine and clean up the description: remove all placeholders, ???, and open-ended hedges ("probably", "TBD", "may need"); replace each with a concrete decision or a structured TODO that names the work and the owner area (backend / mobile / design). Keep the section structure (Description, What it includes, Acceptance, Open questions) but rewrite Open questions as resolved decisions or scoped follow-ups.
