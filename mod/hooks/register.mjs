// Limit Break's Claude Code mod (spec D1): a sensor that writes ~/.limit-break/sessions/<id>.json, and an actuator that continues the session when the Limit Break extension sends a valid control message. It never acts on its own.
import {
  statusPath, controlPath, parseControl, acceptControl, initialStatus, parseStatus,
  withRateLimits, withStopFailure, withNativeContinue, withContinued, movedTo,
} from './control.mjs';

// $ may only be passed to functions declared at the top of this file, so the helpers live here and take the process's state `s` ({ status, home }).

async function homeDir($, s) {
  if (s.home === undefined) {
    s.home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '';
  }
  return s.home;
}

async function write($, s) {
  if (s.status && (await homeDir($, s))) {
    await $.fs.write(statusPath(s.home, s.status.sessionId), JSON.stringify(s.status, null, 2));
  }
}

async function readText($, path) {
  try {
    return await $.fs.read(path);
  } catch {
    return undefined;
  }
}

async function start($, s, sessionId) {
  const h = await homeDir($, s);
  const previousText = h ? await readText($, statusPath(h, sessionId)) : undefined;
  s.status = initialStatus(
    {
      sessionId,
      cwd: await $.session.cwd(),
      entrypoint: await $.env.get('CLAUDE_CODE_ENTRYPOINT'),
      loadedAtMs: await $.clock.now(),
    },
    previousText === undefined ? undefined : parseStatus(previousText),
  );
  await write($, s);
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  /** This process's status (rewritten whole on every change) and home directory. */
  const s = { status: undefined, home: undefined };

  on('session.start', async ($, e, next) => {
    await start($, s, await $.session.id());
    return next(e);
  });

  on('session.measure', async ($, e, next) => {
    if (s.status && e.changed.includes('rateLimits')) {
      s.status = withRateLimits(s.status, e.rateLimits, await $.clock.now());
      await write($, s);
    }
    return next(e);
  });

  on('classic.StopFailure', async ($, e, next) => {
    if (s.status && e.agent_id === undefined) {
      s.status = withStopFailure(s.status, e.error, await $.clock.now());
      await write($, s);
    }
    return next(e);
  });

  on('classic.Notification', async ($, e, next) => {
    if (s.status && typeof e.notification_type === 'string' && e.notification_type.startsWith('quota_auto_resume')) {
      s.status = withNativeContinue(s.status, e.notification_type, await $.clock.now());
      await write($, s);
    }
    return next(e);
  });

  on('classic.SessionStart', async ($, e, next) => {
    if (s.status && e.session_id !== s.status.sessionId && (e.source === 'clear' || e.source === 'resume' || e.source === 'fork')) {
      s.status = movedTo(s.status, e.session_id);
      await write($, s);
      await start($, s, e.session_id);
    }
    return next(e);
  });

  on('session.receive', async ($, e, next) => {
    if (e.agentId !== undefined || e.origin.kind !== 'peer') {
      return next(e);
    }
    const control = parseControl(e.text);
    if (control.kind === 'none') {
      return next(e);
    }
    if (control.kind === 'invalid' || !s.status) {
      $.ui.log(`limit-break: ignored a control message: ${control.kind === 'invalid' ? control.reason : 'no session status yet'}`);
      return { consumed: 'limit-break control message' };
    }
    const verdict = acceptControl(
      control,
      await readText($, controlPath(await homeDir($, s), s.status.sessionId)),
      s.status,
      await $.clock.now(),
    );
    if (!verdict.ok) {
      $.ui.log(`limit-break: refused a control message: ${verdict.reason}`);
      return { consumed: 'limit-break control message' };
    }
    // Unawaited, as spike S4 ran it from session.receive: the turn starts once the session is idle.
    void $.prompt.submit({ text: control.prompt, asUser: true }).then(async () => {
      s.status = withContinued(s.status, control.jobId, await $.clock.now());
      await write($, s);
    });
    return { consumed: 'limit-break control message' };
  });
};
