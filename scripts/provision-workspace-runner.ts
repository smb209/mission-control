/**
 * Phase I: emits the openclaw config block for a per-workspace PM
 * agent. The operator runs this script with a workspace slug, copies
 * the printed JSON into `~/.openclaw/openclaw.json` under
 * `agents.list[]`, and adds the matching tool profile.
 *
 * Usage:
 *   yarn tsx scripts/provision-workspace-runner.ts <slug> [--prod]
 *
 * Examples:
 *   yarn tsx scripts/provision-workspace-runner.ts foia
 *     → emits dev block for `mc-pm-foia-dev`
 *   yarn tsx scripts/provision-workspace-runner.ts foia --prod
 *     → emits prod block for `mc-pm-foia`
 *
 * The script is read-only: it does NOT write to openclaw.json
 * (modifying that file under the operator's nose feels wrong, and
 * openclaw's CLI is the source-of-truth tool for that). It just
 * prints what to add.
 *
 * Constraints checked:
 *   - slug matches the openclaw segment grammar `[a-z0-9][a-z0-9_-]{0,63}`
 *   - slug doesn't collide with reserved prefixes (`agent:`, `cron:`, etc.)
 *   - resulting gateway_agent_id fits the 64-char openclaw segment limit
 */

const SEGMENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_PREFIXES = ['agent', 'cron', 'run', 'thread', 'subagent', 'main'];

function fail(msg: string): never {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
}

function parseArgs(): { slug: string; isProd: boolean } {
  const args = process.argv.slice(2).filter((a) => !!a);
  if (args.length === 0) {
    fail('usage: yarn tsx scripts/provision-workspace-runner.ts <slug> [--prod]');
  }
  let isProd = false;
  let slug: string | null = null;
  for (const a of args) {
    if (a === '--prod') isProd = true;
    else if (a.startsWith('--')) fail(`unknown flag: ${a}`);
    else if (slug === null) slug = a;
    else fail(`unexpected positional arg: ${a}`);
  }
  if (!slug) fail('slug is required');
  return { slug: slug!, isProd };
}

function validateSlug(slug: string): void {
  if (!SEGMENT_RE.test(slug)) {
    fail(
      `slug "${slug}" must match the openclaw segment grammar [a-z0-9][a-z0-9_-]{0,63}`,
    );
  }
  if (RESERVED_PREFIXES.includes(slug)) {
    fail(`slug "${slug}" is a reserved openclaw prefix`);
  }
}

function emit(slug: string, isProd: boolean): void {
  const env = isProd ? '' : '-dev';
  const gatewayId = `mc-pm-${slug}${env}`;
  if (gatewayId.length > 64) {
    fail(
      `gateway_agent_id "${gatewayId}" exceeds the 64-char openclaw segment limit (slug too long)`,
    );
  }
  const mcpServer = isProd ? 'sc-mission-control' : 'sc-mission-control-dev';
  const otherMcp = isProd ? 'sc-mission-control-dev' : 'sc-mission-control';

  const block = {
    id: gatewayId,
    name: `MC PM (${slug}${isProd ? '' : ' / dev'})`,
    workspace: `~/.openclaw/workspaces/${gatewayId}`,
    model: 'spark-lb/agent',
    skills: [
      'acp-router',
      'discord',
      'github',
      'gog',
      'healthcheck',
      'node-connect',
      'openai-whisper',
      'peekaboo',
      'session-logs',
      'skill-creator',
      'tmux',
      'video-frames',
      'taskflow',
    ],
    heartbeat: {
      every: '4h',
      model: 'spark-lb/agent',
    },
    tools: {
      profile: 'coding',
      alsoAllow: ['browser', `${mcpServer}__*`],
      deny: [
        'image_generate',
        'music_generate',
        'video_generate',
        `${otherMcp}__*`,
      ],
    },
  };

  process.stdout.write('# Phase I per-workspace PM agent\n');
  process.stdout.write(
    `# Add the following entry under agents.list[] in ~/.openclaw/openclaw.json:\n\n`,
  );
  process.stdout.write(JSON.stringify(block, null, 2));
  process.stdout.write('\n\n');

  process.stderr.write(`gateway_agent_id: ${gatewayId}\n`);
  process.stderr.write(`workspace dir:    ~/.openclaw/workspaces/${gatewayId}/\n`);
  process.stderr.write(`mcp scope:        ${mcpServer}__* (allowed) + ${otherMcp}__* (denied)\n`);
  process.stderr.write(`\nNext steps:\n`);
  process.stderr.write(`  1. Paste the JSON block above into agents.list[] in ~/.openclaw/openclaw.json\n`);
  process.stderr.write(`  2. Run: openclaw mcp show ${mcpServer}   (verify config)\n`);
  process.stderr.write(`  3. Restart the dev server (catalog sync picks up the new agent within 60s)\n`);
  process.stderr.write(`  4. Verify: sqlite3 mission-control.db "SELECT name, gateway_agent_id, workspace_id, is_pm, is_master FROM agents WHERE gateway_agent_id='${gatewayId}'"\n`);
}

function main(): void {
  const { slug, isProd } = parseArgs();
  validateSlug(slug);
  emit(slug, isProd);
}

main();
