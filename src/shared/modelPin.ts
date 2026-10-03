/**
 * MODEL-PINBACK: which model an agent runs, and how an in-TUI model switch survives a respawn.
 *
 * THE AUTHORITY. The app's model picker is the authority: the renderer bakes its choice into the
 * spawn command as `--model <picked>` (the REQUESTED model), and a CLI flag beats any `model =` in
 * a config file. A user can still switch model inside the TUI (`/model`). That switch lives only in
 * the running process, so a respawn (restart, rotation, resume) went back to the picked model.
 *
 * THE PIN. Main observes the LIVE model (Claude: the status line; Codex: the rollout's
 * `turn_context.payload.model`; Antigravity: the statusline's `model.id`). When the live model
 * CHANGES away from what this process was launched with, the user switched: the new model is
 * pinned on the agent's registry entry together with the requested model it replaced
 * (`modelPinnedFrom`). The next spawn uses the pin ONLY while the renderer still requests that same
 * model; a different request means the picker was used since, so the picker wins and the pin is
 * dropped. A live switch back to the requested model clears the pin.
 *
 * WHAT IS NEVER A SWITCH:
 *   - the first observation when the launch model is unknown (no `--model`: the CLI's own
 *     default) - it only establishes the baseline;
 *   - an observation equal to the last live (or launch) model, e.g. a thread's first turn_context;
 *   - an observation stamped before this process was launched (a stale rollout line from the
 *     previous process of a resumed thread).
 *
 * USER OR AUTO. A CLI can also change model ON ITS OWN (a plan-limit Opus->Sonnet fallback, or
 * a Codex/AGY equivalent) and report it as the live model; the observation itself cannot tell
 * that from a user's `/model`. So every pin carries a SOURCE, decided by the only evidence main
 * has: whether HUMAN input (renderer-originated terminal input, `shared/inputOrigin.ts`; app
 * writes are PROGRAMMATIC or CONTROL and never count) reached this agent's pty since the
 * previous live-model observation (or since launch). Yes = 'user', no = 'auto'.
 *   - A 'user' pin is kept across a respawn (while the picker is unchanged).
 *   - An 'auto' pin is shown and logged but NOT kept: the respawn runs the picker model and logs
 *     the auto pin as dropped.
 * The signal is necessary, not sufficient: a fallback that happens in a turn the human just
 * typed a prompt for is classified 'user'. A pin from before this rule has no source and is
 * kept as it always was. A purely provider-side reroute that the CLI does not report is
 * invisible and pins nothing.
 *
 * THE WINDOW (AGENT-MODEL-NOT-KEPT M1, 1.1.79). "Since the previous observation" means since the
 * previous observation's OWN time: a Codex turn_context's stamp, not the wall clock of the hook
 * that read it. Codex is observed at every hook, UserPromptSubmit included, and there the newest
 * turn_context is still the previous turn's; stamping the window with the hook's time moved it
 * past the person's `/model` keys, so their switch was read as 'auto' (Dwight, 2026-10-02
 * 05:51:08 `/model`, pinned 'auto' at the 05:55:46 wake turn). The window marker only advances.
 *
 * EFFORT (M2). Where the CLI reports a reasoning effort with the model (Codex: turn_context
 * `effort`), the pin is the PAIR {model, effort}: an effort-only switch pins too, the pin's effort
 * is what the next spawn runs (Codex: `-c model_reasoning_effort=<e>` and the generated
 * config.toml), and the picker's effort (`requestedEffort`) is part of the request a pin is valid
 * against. With no effort reported, everything above works on the model alone, as before.
 */

export type ModelPinSource = 'user' | 'auto';

export interface ModelPinFields {
  /** The pinned live model (a user's in-TUI switch), if any. */
  model?: string;
  /** The requested (picker) model in force when the pin was recorded; absent = none requested. */
  modelPinnedFrom?: string;
  /** The renderer's `--model` at the last spawn; absent = none. */
  requestedModel?: string;
  /** The `--model` this process was actually launched with; absent = the CLI's own default. */
  launchModel?: string;
  /** The last live model observed from this process. */
  liveModel?: string;
  /** When this process was launched (ms). Absent = spawned before MODEL-PINBACK. */
  launchedAt?: number;
  /** Who made the pin: 'user' (human input preceded it) or 'auto' (none did). Absent = a pin
   *  from before this rule, kept as before. */
  modelPinSource?: ModelPinSource;
  /** M2: the pinned effort, recorded with the pinned model; absent = none reported. */
  modelEffort?: string;
  /** M2: the requested (picker) effort in force when the pin was recorded; absent = none. */
  modelPinnedFromEffort?: string;
  /** M2: the picker's effort at the last spawn (Codex `-c model_reasoning_effort=`); absent = none. */
  requestedEffort?: string;
  /** M2: the effort this process was launched with (pin, else request); absent = the CLI's own. */
  launchEffort?: string;
  /** M2: the last live effort observed from this process. */
  liveEffort?: string;
  /** M2: the effort the agent gets with no pin and no request (the seed's, else the first one
   *  observed from such a launch); what a return to "no switch" is compared with. */
  defaultEffort?: string;
  /** Claude: the model whose no-switch effort was learned. A default is never portable across models. */
  defaultEffortModel?: string;
}

const norm = (m: string | undefined | null): string => (m ?? '').trim().toLowerCase();

/** An effort as a CLI names it ("medium", "xhigh"), lower-cased; anything else (empty, spaces,
 *  quotes, over-long) is no effort, so a value can never break an argv or a TOML line. */
export function normEffort(e: string | undefined | null): string | undefined {
  const v = (e ?? '').trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(v) ? v : undefined;
}

/** Two efforts are the same (both absent counts as the same). */
export function sameEffort(a: string | undefined | null, b: string | undefined | null): boolean {
  return normEffort(a) === normEffort(b);
}

/** Codex's config key for the reasoning effort; on its argv it is `-c model_reasoning_effort=<e>`. */
export const CODEX_EFFORT_KEY = 'model_reasoning_effort';

/** The effort a Codex argv requests (`-c|--config model_reasoning_effort=<e>`, `--config=...`); the
 *  last one wins, as in Codex. A TOML-quoted value ("medium") is unquoted. */
export function codexEffortValue(args: readonly string[]): string | undefined {
  let found: string | undefined;
  const take = (kv: string): void => {
    const m = /^\s*model_reasoning_effort\s*=\s*(.*)$/.exec(kv);
    if (m) found = normEffort(m[1].trim().replace(/^(["'])(.*)\1$/, '$2'));
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '-c' || a === '--config') && typeof args[i + 1] === 'string') { take(args[i + 1]); i++; }
    else if (a.startsWith('--config=')) take(a.slice('--config='.length));
  }
  return found;
}

/** The argv with its Codex effort override set to `effort` (each existing one replaced; appended
 *  when absent). */
export function withCodexEffort(args: readonly string[], effort: string): string[] {
  const kv = `${CODEX_EFFORT_KEY}=${effort}`;
  const out = [...args];
  let replaced = false;
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    if ((a === '-c' || a === '--config') && /^\s*model_reasoning_effort\s*=/.test(out[i + 1] ?? '')) { out[i + 1] = kv; replaced = true; i++; }
    else if (a.startsWith('--config=') && /^\s*model_reasoning_effort\s*=/.test(a.slice('--config='.length))) { out[i] = `--config=${kv}`; replaced = true; }
  }
  if (!replaced) out.push('-c', kv);
  return out;
}

/** Two model ids name the same model (whitespace/case only). `[1m]` stays significant. */
export function sameModel(a: string | undefined | null, b: string | undefined | null): boolean {
  return norm(a) === norm(b);
}

/** The value of `--model` in an argv (`--model X` or `--model=X`), if present. */
export function modelFlagValue(args: readonly string[], flag = '--model'): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) {
      const v = args[i + 1];
      return typeof v === 'string' && v.trim() ? v : undefined;
    }
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1) || undefined;
  }
  return undefined;
}

/** The argv with its `--model` value replaced by `model` (appended when absent). */
export function withModelFlag(args: readonly string[], model: string, flag = '--model'): string[] {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === flag && i + 1 < out.length) { out[i + 1] = model; return out; }
    if (out[i].startsWith(`${flag}=`)) { out[i] = `${flag}=${model}`; return out; }
  }
  out.push(flag, model);
  return out;
}

/**
 * The model a spawn should run. `requested` is the renderer's `--model` (undefined = none). The pin
 * is used only while the request is the one it was pinned against; otherwise the request wins and
 * the pin is stale (`dropPin`).
 */
export function resolveSpawnModel(
  entry: ModelPinFields | undefined,
  requested: string | undefined,
  requestedEffort?: string
): { model: string | undefined; effort?: string; pinApplied: boolean; dropPin: boolean; dropReason?: 'auto-not-kept' | 'picker-changed' } {
  const req = requested?.trim() || undefined;
  const reqEffort = normEffort(requestedEffort);
  const pin = entry?.model?.trim() || undefined;
  if (!pin) {
    // Claude can switch effort without switching model. That effort choice is an independent
    // pin: keep it across app-default model changes, but let an explicit picker effort override it.
    const effortPin = normEffort(entry?.modelEffort);
    const effortMatches = !!effortPin && entry?.modelPinSource !== 'auto'
      && sameEffort(entry?.modelPinnedFromEffort, reqEffort);
    const dropEffort = !!effortPin && !effortMatches;
    return {
      model: req, effort: effortMatches ? effortPin : reqEffort, pinApplied: false, dropPin: dropEffort,
      ...(dropEffort ? { dropReason: 'picker-changed' as const } : {})
    };
  }
  // An automatic switch is never carried into a new process: the picker model runs again.
  if (entry?.modelPinSource === 'auto') return { model: req, effort: reqEffort, pinApplied: false, dropPin: true, dropReason: 'auto-not-kept' };
  // M2: the request a pin is valid against is the picker's model AND effort (a pin from before
  // 1.1.79 has no effort on either side, so it still applies).
  if (sameModel(entry?.modelPinnedFrom, req) && sameEffort(entry?.modelPinnedFromEffort, reqEffort)) {
    return { model: pin, effort: normEffort(entry?.modelEffort) ?? reqEffort, pinApplied: true, dropPin: false };
  }
  return { model: req, effort: reqEffort, pinApplied: false, dropPin: true, dropReason: 'picker-changed' };
}

export type LiveModelAction = 'stale' | 'unknown-launch' | 'baseline' | 'unchanged' | 'pin' | 'unpin';

/**
 * Apply one live-model observation to an entry, IN PLACE. Returns what happened and whether the
 * entry changed (so the caller persists only on a change).
 *
 * `fallbackBaseline` is the model the agent runs when nothing is requested (Claude: the app
 * default). It is also what makes a pre-MODEL-PINBACK Claude entry (no launch record) keep the old
 * behaviour: pin a divergence from the default, clear the pin on a return to it.
 */
export function applyLiveModel(
  entry: ModelPinFields,
  liveRaw: string,
  opts: { observedAt?: number; fallbackBaseline?: string; humanInputSince?: boolean; effort?: string | null; independentEffortPin?: boolean } = {}
): { action: LiveModelAction; changed: boolean } {
  const source: ModelPinSource = opts.humanInputSince === true ? 'user' : 'auto';
  const live = liveRaw.trim();
  if (!live) return { action: 'unchanged', changed: false };
  const liveEffort = normEffort(opts.effort);
  const baseline = entry.requestedModel ?? opts.fallbackBaseline;
  // M2: "no switch" is the requested model at the requested (else default) effort. An effort
  // nobody knows on either side never makes a difference.
  const baselineEffort = normEffort(entry.requestedEffort) ?? normEffort(entry.defaultEffort);
  const atBaseline = (): boolean => baseline !== undefined && sameModel(live, baseline)
    && (liveEffort === undefined || baselineEffort === undefined || liveEffort === baselineEffort);
  const setPin = (): { action: LiveModelAction; changed: boolean } => {
    if (atBaseline()) {
      if (entry.model === undefined && entry.modelPinnedFrom === undefined && entry.modelEffort === undefined && entry.modelPinSource === undefined) return { action: 'unpin', changed: false };
      delete entry.model;
      delete entry.modelPinnedFrom;
      delete entry.modelPinSource;
      delete entry.modelEffort;
      delete entry.modelPinnedFromEffort;
      return { action: 'unpin', changed: true };
    }
    const modelIsBaseline = baseline !== undefined && sameModel(live, baseline);
    if (sameModel(entry.model, live) && sameModel(entry.modelPinnedFrom, entry.requestedModel)
      && (liveEffort === undefined || sameEffort(entry.modelEffort, liveEffort))
      && sameEffort(entry.modelPinnedFromEffort, entry.requestedEffort)) {
      return { action: 'pin', changed: false };
    }
    // Claude's /effort is independent from /model. Leave the picked/default model unpinned when
    // only effort differs; Codex retains the paired {model, effort} behavior.
    if (opts.independentEffortPin && modelIsBaseline) {
      delete entry.model;
      delete entry.modelPinnedFrom;
    } else {
      entry.model = live;
      if (entry.requestedModel !== undefined) entry.modelPinnedFrom = entry.requestedModel;
      else delete entry.modelPinnedFrom;
    }
    entry.modelPinSource = source;
    if (liveEffort !== undefined) entry.modelEffort = liveEffort;
    else delete entry.modelEffort;
    const reqEffort = normEffort(entry.requestedEffort);
    if (reqEffort !== undefined) entry.modelPinnedFromEffort = reqEffort;
    else delete entry.modelPinnedFromEffort;
    return { action: 'pin', changed: true };
  };

  if (entry.launchedAt === undefined) {
    // Spawned before this version: only Claude had a pin, against its app default.
    if (opts.fallbackBaseline === undefined) return { action: 'unknown-launch', changed: false };
    return setPin();
  }
  // A line written before this process started belongs to a previous process (a resumed
  // thread's rollout still ends with the old turns). Codex stamps whole seconds, so compare
  // against the launch second.
  if (opts.observedAt !== undefined && opts.observedAt < Math.floor(entry.launchedAt / 1000) * 1000) {
    return { action: 'stale', changed: false };
  }
  // M2: the effort this process ran until now: the last live one, else the launch one, else the
  // seed's (Creed B1: a /model before the first turn, on a seed effort, is a switch). Launched
  // with none known at all, the first reported effort is the CLI's own default: a baseline.
  const previousEffort = normEffort(entry.liveEffort) ?? normEffort(entry.launchEffort) ?? normEffort(entry.defaultEffort);
  let effortBaseline = false;
  if (liveEffort !== undefined && previousEffort === undefined) {
    entry.liveEffort = liveEffort;
    if (entry.defaultEffort === undefined && entry.requestedEffort === undefined && entry.modelEffort === undefined) {
      entry.defaultEffort = liveEffort;
      if (opts.fallbackBaseline !== undefined) entry.defaultEffortModel = live;
    }
    effortBaseline = true;
  }
  const effortSwitched = liveEffort !== undefined && previousEffort !== undefined && liveEffort !== previousEffort;
  const previous = entry.liveModel ?? entry.launchModel;
  if (previous === undefined) {
    // Launched on the CLI's own default: the first observation is that default, not a switch
    // (its effort may still be one).
    entry.liveModel = live;
    if (!effortSwitched) {
      if (liveEffort !== undefined) entry.liveEffort = liveEffort;
      return { action: 'baseline', changed: true };
    }
  } else if (sameModel(previous, live) && !effortSwitched) {
    // The first reported effort is recorded even when it is the expected one (the card shows it).
    if (liveEffort !== undefined && entry.liveEffort === undefined) { entry.liveEffort = liveEffort; effortBaseline = true; }
    return effortBaseline ? { action: 'baseline', changed: true } : { action: 'unchanged', changed: false };
  }
  entry.liveModel = live;
  if (liveEffort !== undefined) entry.liveEffort = liveEffort;
  setPin();
  return { action: atBaseline() ? 'unpin' : 'pin', changed: true };
}

/** G3 panel text for an agent's model: a small marker and a plain tooltip. The marker is only
 *  present while a pin is in force, and says which kind. */
export function modelPinLabel(entry: ModelPinFields | undefined, picked?: string): { model?: string; marker: '' | 'pinned' | 'auto'; tooltip: string } {
  const bare = effectiveModel(entry);
  if (!bare) return { marker: '', tooltip: '' };
  // M2: the card names the effort with the model ("gpt-5.6-luna · medium") when one is known.
  const effort = effectiveEffort(entry);
  const model = effort ? `${bare} · ${effort}` : bare;
  const pinned = entry?.model ? (normEffort(entry.modelEffort) ? `${entry.model} · ${normEffort(entry.modelEffort)}` : entry.model) : '';
  const over = picked && entry?.model && !sameModel(picked, entry.model) ? ` over the picked ${picked}` : '';
  if (entry?.model && entry.modelPinSource === 'auto') {
    return { model, marker: 'auto', tooltip: `Runs ${pinned}. Auto: the CLI switched model on its own (e.g. a usage-limit fallback)${over}; not kept after a restart. If it was you, press keep.` };
  }
  if (entry?.model) {
    return { model, marker: 'pinned', tooltip: `Runs ${pinned}. Pinned: switched by you in the terminal${over}; kept after a restart. Change the model picker to override.` };
  }
  return { model, marker: '', tooltip: `Runs ${model}.` };
}

/** The model an agent is running as far as main knows: live, else launched, else pinned. */
export function effectiveModel(entry: ModelPinFields | undefined): string | undefined {
  return entry?.liveModel ?? entry?.launchModel ?? entry?.model;
}

/** M2: the effort an agent is running as far as main knows: live, else launched, else pinned. */
export function effectiveEffort(entry: ModelPinFields | undefined): string | undefined {
  return normEffort(entry?.liveEffort) ?? normEffort(entry?.launchEffort) ?? normEffort(entry?.modelEffort);
}

/**
 * A spawn's argv with the model it really runs: the renderer's `--model` (the request), replaced
 * by a pin that still applies, or `fallback` when neither exists (Claude: the app default).
 * Returns the request and the launch model for the registry record.
 */
export function resolveSpawnArgs(
  entry: ModelPinFields | undefined,
  args: readonly string[],
  opts: { flag?: string; fallback?: string; effort?: 'codex' | 'claude' } = {}
): { args: string[]; requested?: string; launch?: string; requestedEffort?: string; launchEffort?: string } {
  const flag = opts.flag ?? '--model';
  const requested = modelFlagValue(args, flag)?.trim() || undefined;
  // M2 (Codex): the picker's effort rides on the argv as `-c model_reasoning_effort=<e>`.
  const requestedEffort = opts.effort === 'codex' ? codexEffortValue(args)
    : opts.effort === 'claude' ? flagValue(args, '--effort') : undefined;
  const resolved = resolveSpawnModel(entry, requested, requestedEffort);
  const launch = resolved.model ?? (opts.fallback?.trim() || undefined);
  let out = launch && !sameModel(launch, requested) ? withModelFlag(args, launch, flag) : [...args];
  const launchEffort = opts.effort === 'codex' ? resolved.effort : opts.effort === 'claude' ? resolved.effort : undefined;
  if (opts.effort === 'codex' && launchEffort && launchEffort !== requestedEffort) out = withCodexEffort(out, launchEffort);
  if (opts.effort === 'claude' && launchEffort && launchEffort !== requestedEffort) out = withFlag(out, '--effort', launchEffort);
  return {
    args: out, requested, launch,
    ...(opts.effort ? { requestedEffort, launchEffort } : {})
  };
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && typeof args[i + 1] === 'string') value = normEffort(args[++i]);
    else if (args[i].startsWith(`${flag}=`)) value = normEffort(args[i].slice(flag.length + 1));
  }
  return value;
}

function withFlag(args: readonly string[], flag: string, value: string): string[] {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === flag && i + 1 < out.length) { out[i + 1] = value; return out; }
    if (out[i].startsWith(`${flag}=`)) { out[i] = `${flag}=${value}`; return out; }
  }
  out.push(flag, value);
  return out;
}
