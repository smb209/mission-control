/**
 * Configuration Management
 * 
 * Handles user-configurable settings for Mission Control.
 * Settings are stored in localStorage for client-side access.
 * 
 * NEVER commit hardcoded IPs, paths, or sensitive data!
 */

export interface MissionControlConfig {
  // Workspace settings
  workspaceBasePath: string; // e.g., ~/Documents/Shared
  projectsPath: string; // e.g., ${workspaceBasePath}/projects
  
  // Mission Control API URL (for orchestration)
  missionControlUrl: string; // Auto-detected or manually set
  
  // OpenClaw Gateway settings (these come from .env on server)
  // Client-side only needs to know if it's configured
  
  // Project defaults
  defaultProjectName: string; // 'mission-control' or custom

  // UX preferences
  kanbanCompactEmptyColumns: boolean; // shrink empty columns to fit header text
}

const DEFAULT_CONFIG: MissionControlConfig = {
  workspaceBasePath: '~/Documents/Shared',
  projectsPath: '~/Documents/Shared/projects',
  missionControlUrl: typeof window !== 'undefined' ? window.location.origin : `http://localhost:${process.env.PORT || '4000'}`,
  defaultProjectName: 'mission-control',
  kanbanCompactEmptyColumns: false,
};

const CONFIG_KEY = 'mission-control-config';

/**
 * Get current configuration
 * Returns defaults merged with user overrides
 */
export function getConfig(): MissionControlConfig {
  if (typeof window === 'undefined') {
    return DEFAULT_CONFIG;
  }

  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch (error) {
    console.error('Failed to load config:', error);
  }

  return DEFAULT_CONFIG;
}

/**
 * Update configuration
 * Validates and saves to localStorage
 */
export function updateConfig(updates: Partial<MissionControlConfig>): void {
  if (typeof window === 'undefined') {
    throw new Error('Cannot update config on server side');
  }

  const current = getConfig();
  const updated = { ...current, ...updates };

  // Validate paths
  if (updates.workspaceBasePath !== undefined) {
    if (!updates.workspaceBasePath.trim()) {
      throw new Error('Workspace base path cannot be empty');
    }
  }

  if (updates.missionControlUrl !== undefined) {
    try {
      new URL(updates.missionControlUrl);
    } catch {
      throw new Error('Invalid Mission Control URL');
    }
  }

  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(updated));
  } catch (error) {
    console.error('Failed to save config:', error);
    throw new Error('Failed to save configuration');
  }
}

/**
 * Reset configuration to defaults
 */
export function resetConfig(): void {
  if (typeof window === 'undefined') {
    throw new Error('Cannot reset config on server side');
  }

  localStorage.removeItem(CONFIG_KEY);
}

/**
 * Expand tilde in paths (for display purposes)
 * Note: Actual path resolution happens server-side
 */
export function expandPath(path: string): string {
  if (typeof window === 'undefined') {
    return path;
  }

  // This is client-side only - server will handle actual expansion
  return path.replace(/^~/, process.env.HOME || '/Users/user');
}

/**
 * Get Mission Control URL for API calls
 * Used by orchestration module and other server-side modules
 */
export function getMissionControlUrl(): string {
  // Server-side: use env var or auto-detect
  if (typeof window === 'undefined') {
    return process.env.MISSION_CONTROL_URL || `http://localhost:${process.env.PORT || '4000'}`;
  }

  // Client-side: use config
  return getConfig().missionControlUrl;
}

/**
 * Get workspace base path
 * Server-side only - returns configured path or default
 */
export function getWorkspaceBasePath(): string {
  if (typeof window !== 'undefined') {
    return getConfig().workspaceBasePath;
  }

  // Server-side: check env var first, then default
  return process.env.WORKSPACE_BASE_PATH || '~/Documents/Shared';
}

/**
 * Get projects path
 * Server-side only - returns configured path or default
 */
export function getProjectsPath(): string {
  if (typeof window !== 'undefined') {
    return getConfig().projectsPath;
  }

  // Server-side: check env var first, then default
  return process.env.PROJECTS_PATH || '~/Documents/Shared/projects';
}

/**
 * Build project-specific path
 * @param projectName - Name of the project
 * @param subpath - Optional subpath within project (e.g., 'deliverables')
 */
export function getProjectPath(projectName: string, subpath?: string): string {
  const projectsPath = getProjectsPath();
  const base = `${projectsPath}/${projectName}`;
  return subpath ? `${base}/${subpath}` : base;
}

/**
 * Default workspace path for a given workspace slug. Used both as the
 * value persisted on workspace creation when the operator doesn't pass
 * an explicit override, AND as the placeholder shown on the workspace
 * settings page when `workspace_path` is null.
 *
 * Resolution order — most specific to least:
 *   1. MC_DELIVERABLES_HOST_PATH      (set on the host process when
 *                                       MC runs in a docker container
 *                                       but dispatches to host gateway)
 *   2. MC_DELIVERABLES_CONTAINER_PATH (set inside the container so MC
 *                                       can read its own filesystem)
 *   3. PROJECTS_PATH                  (legacy generic env)
 *   4. ~/Documents/Shared/projects    (final fallback)
 *
 * The host path wins because gateway agents execute on the host —
 * persisting the host path on the workspace row ensures task
 * dispatches resolve to a real directory the gateway can write to.
 * Operators in non-container setups will only have one of these set
 * anyway, so the precedence is benign there.
 */
export function getDefaultWorkspaceRoot(): string {
  if (typeof window !== 'undefined') {
    return getConfig().projectsPath;
  }
  return (
    process.env.MC_DELIVERABLES_HOST_PATH ||
    process.env.MC_DELIVERABLES_CONTAINER_PATH ||
    process.env.PROJECTS_PATH ||
    '~/Documents/Shared/projects'
  );
}

/**
 * Per-workspace path resolver. Either returns the operator's explicit
 * override (if any) or `<defaultRoot>/<slug>`. Server-side only;
 * callers that have a `Workspace` row should use this instead of
 * concatenating manually.
 */
export function resolveWorkspacePath(slug: string, override?: string | null): string {
  if (override && override.trim().length > 0) return override.trim();
  return `${getDefaultWorkspaceRoot()}/${slug}`;
}
