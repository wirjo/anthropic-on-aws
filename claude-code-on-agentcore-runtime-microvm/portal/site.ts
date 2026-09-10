// Static portal assets served by portal/handler.ts through the private API.
// This is a minimal placeholder for claude-code-on-agentcore-runtime-microvm:
// only the Terminal access mode is implemented in this sample (see
// docs/deployment-guide.md), so the page only needs session lifecycle
// controls and an xterm.js terminal dialog -- no VS Code tunnel UI.

export const PORTAL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude AgentCore Runtime portal</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="xterm.css">
<style>
  :root { color-scheme: light; font-family: system-ui, sans-serif; }
  body { margin: 0; background: #f5f7f8; color: #182126; }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: .75rem 1.5rem;
    border-bottom: 1px solid #d7dfe2;
    background: #fff;
  }
  main { padding: 1.5rem; max-width: 60rem; margin: 0 auto; }
  button {
    border: 1px solid #d7dfe2;
    border-radius: 4px;
    background: #fff;
    padding: .45rem .75rem;
    cursor: pointer;
  }
  button.primary { background: #006d77; color: #fff; border-color: #006d77; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  th, td { text-align: left; padding: .5rem; border-bottom: 1px solid #eef2f3; }
  dialog { width: min(90vw, 60rem); border: none; border-radius: 6px; padding: 0; }
  #terminal-screen { height: 60vh; background: #101418; padding: .5rem; }
  #error { color: #b42318; margin-top: .5rem; }
</style>
</head>
<body>
<header>
  <h1>Claude AgentCore Runtime</h1>
  <div>
    <span id="who"></span>
    <button id="sign-out" hidden>Sign out</button>
  </div>
</header>
<main>
  <button id="sign-in" class="primary">Sign in</button>
  <section id="app" hidden>
    <button id="start-session" class="primary">Create environment</button>
    <button id="refresh">Refresh</button>
    <table>
      <thead>
        <tr><th>Session</th><th>Workspace</th><th>State</th><th>Updated</th><th></th></tr>
      </thead>
      <tbody id="sessions"></tbody>
    </table>
    <p id="error" hidden></p>
  </section>
</main>
<dialog id="terminal-dialog">
  <div id="terminal-screen"></div>
  <button id="terminal-close">Close</button>
</dialog>
<script src="terminal-vendor.js"></script>
<script src="app.js"></script>
</body>
</html>`;

export const PORTAL_JS = `
'use strict';
var config;
var sessions = [];

function el(id) { return document.getElementById(id); }

async function loadConfig() {
  if (!config) {
    var response = await fetch('config.json');
    config = await response.json();
  }
  return config;
}

function base64Url(bytes) {
  var text = '';
  new Uint8Array(bytes).forEach(function (byte) {
    text += String.fromCharCode(byte);
  });
  return btoa(text)
    .replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');
}

function idToken() { return sessionStorage.getItem('portalIdToken'); }

function hostedUiUrl(cfg, endpoint) {
  return 'https://' + cfg.userPoolDomain + '/oauth2/' + endpoint;
}

function claims() {
  var token = idToken();
  if (!token) { return null; }
  try {
    var encoded = token.split('.')[1]
      .replace(/-/g, '+').replace(/_/g, '/');
    encoded += '='.repeat((4 - encoded.length % 4) % 4);
    return JSON.parse(atob(encoded));
  } catch (error) { return null; }
}

function signedIn() {
  var current = claims();
  return Boolean(current && current.exp * 1000 > Date.now());
}

function signOut() {
  sessionStorage.removeItem('portalIdToken');
  sessionStorage.removeItem('portalVerifier');
  sessionStorage.removeItem('portalState');
  render();
}

// Authorization Code + PKCE against the Cognito Hosted UI. There is no
// client secret (public client), so PKCE is what stops a stolen
// authorization code from being redeemed by anyone but the browser that
// requested it.
async function login() {
  var cfg = await loadConfig();
  var verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  var digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(verifier));
  var state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('portalVerifier', verifier);
  sessionStorage.setItem('portalState', state);
  var authorize = {
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: 'openid profile email',
    state: state,
    code_challenge_method: 'S256',
    code_challenge: base64Url(digest),
  };
  location.assign(
    hostedUiUrl(cfg, 'authorize') + '?' + new URLSearchParams(authorize));
}

async function completeLogin() {
  var params = new URLSearchParams(location.search);
  var code = params.get('code');
  var oauthError = params.get('error');
  if (!code && !oauthError) { return; }
  history.replaceState(null, '', location.pathname);
  var expectedState = sessionStorage.getItem('portalState');
  if (!expectedState || params.get('state') !== expectedState) {
    throw new Error('Sign-in state mismatch; try again');
  }
  if (oauthError) {
    throw new Error(
      'Sign-in failed: ' + (params.get('error_description') || oauthError));
  }
  var cfg = await loadConfig();
  var verifier = sessionStorage.getItem('portalVerifier');
  if (!verifier) {
    throw new Error('Sign-in session expired; try again');
  }
  var res = await fetch(hostedUiUrl(cfg, 'token'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      code: code,
      code_verifier: verifier,
    }),
  });
  var tokens = await res.json();
  if (!res.ok || !tokens.id_token) {
    throw new Error('Token exchange failed: ' + (tokens.error || res.status));
  }
  sessionStorage.setItem('portalIdToken', tokens.id_token);
  sessionStorage.removeItem('portalVerifier');
  sessionStorage.removeItem('portalState');
}

function api(method, path, body) {
  return fetch(path, {
    method: method,
    headers: Object.assign(
      { authorization: idToken() },
      body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  }).then(function (response) {
    if (response.status === 401) {
      signOut();
      throw new Error('Session expired; sign in again');
    }
    if (!response.ok) {
      return response.json().catch(function () { return {}; }).then(function (value) {
        var error = new Error(value.message || 'Request failed');
        error.status = response.status;
        throw error;
      });
    }
    return response.status === 204 ? undefined : response.json();
  });
}

function showError(error) {
  el('error').textContent = error && error.message ? error.message : String(error);
  el('error').hidden = false;
}

function clearError() {
  el('error').textContent = '';
  el('error').hidden = true;
}

function renderSessions() {
  var body = el('sessions');
  body.replaceChildren();
  sessions.forEach(function (session) {
    var row = document.createElement('tr');
    var cells = [
      session.sessionId.slice(0, 8),
      session.workspaceId,
      session.state,
      new Date(session.updatedAt * 1000).toLocaleString()
    ];
    cells.forEach(function (text) {
      var cell = document.createElement('td');
      cell.textContent = text;
      row.appendChild(cell);
    });
    var actions = document.createElement('td');
    var connectButton = document.createElement('button');
    connectButton.textContent = 'Connect';
    connectButton.addEventListener('click', function () {
      openTerminal(session);
    });
    actions.appendChild(connectButton);
    row.appendChild(actions);
    body.appendChild(row);
  });
}

async function refresh() {
  clearError();
  try {
    var result = await api('GET', 'sessions');
    sessions = result.sessions;
    renderSessions();
  } catch (error) {
    showError(error);
  }
}

async function startSession() {
  clearError();
  var button = el('start-session');
  button.disabled = true;
  var originalText = button.textContent;
  button.textContent = 'Starting...';
  try {
    var result = await api('POST', 'sessions', { accessMode: 'terminal' });
    await refresh();
    // POST /sessions returns 200 (not 201/202) when it silently reused an
    // already-active session for this workspace instead of creating a new
    // one -- with no visible change to the table, clicking the button
    // looked like it did nothing. Surface which one actually happened.
    el('error').textContent = result && result.created === false
      ? 'Reusing the existing environment for this workspace (already running).'
      : 'Environment created.';
    el('error').hidden = false;
    setTimeout(clearError, 4000);
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

var terminal;
var terminalSocket;

function openTerminal(session) {
  clearError();
  el('terminal-dialog').showModal();
  terminal = new window.Terminal({ convertEol: true });
  terminal.open(el('terminal-screen'));
  connectTerminal(session);
}

// Shell-protocol channel-prefix framing (Kubernetes v5.channel.k8s.io wire
// format: [1-byte channel id][payload]), matching client/src/shell-
// protocol.ts exactly -- see that file for the full channel table. The
// portal previously wrote every incoming frame straight to the terminal
// (including the leading channel byte as a garbage character) and never
// prefixed outgoing keystrokes with the STDIN channel byte at all, so even
// with a working signed connection the terminal would have been unusable.
var SHELL_CHANNEL_STDIN = 0x00;
var SHELL_CHANNEL_STDOUT = 0x01;
var SHELL_CHANNEL_STDERR = 0x02;
var SHELL_CHANNEL_STATUS = 0x03;
var SHELL_CHANNEL_HEARTBEAT = 0x05;

function encodeStdinFrame(text) {
  var body = new TextEncoder().encode(text);
  var frame = new Uint8Array(body.length + 1);
  frame[0] = SHELL_CHANNEL_STDIN;
  frame.set(body, 1);
  return frame;
}

async function connectTerminal(session) {
  try {
    var connection = await api('POST', 'sessions/' + session.sessionId + '/connect', {});
    var socket = new WebSocket(connection.shellUrl);
    terminalSocket = socket;
    socket.binaryType = 'arraybuffer';
    var bootstrapSent = false;
    var heartbeatTimer = setInterval(function () {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(new Uint8Array([SHELL_CHANNEL_HEARTBEAT]));
      }
    }, 20000);
    socket.addEventListener('close', function () { clearInterval(heartbeatTimer); });
    socket.addEventListener('message', function (event) {
      var frame = new Uint8Array(event.data);
      if (frame.length === 0) { return; }
      var channel = frame[0];
      var payload = frame.subarray(1);
      if (channel === SHELL_CHANNEL_STDOUT || channel === SHELL_CHANNEL_STDERR) {
        terminal.write(payload);
      } else if (channel === SHELL_CHANNEL_STATUS) {
        try {
          var status = JSON.parse(new TextDecoder().decode(payload));
          if (status.status === 'Failure') {
            showError(new Error(status.message || status.reason || 'Shell error'));
          } else if (!bootstrapSent && socket.readyState === WebSocket.OPEN) {
            // Matches client/src/terminal.ts's developerShellBootstrapCommand():
            // drop the shell's default root privileges to the developer user
            // and load the session's Bedrock environment. Without this, the
            // portal terminal connects fine but lands in an unconfigured
            // root shell with no CLAUDE_CODE_USE_BEDROCK/ANTHROPIC_MODEL set.
            bootstrapSent = true;
            socket.send(encodeStdinFrame(
              'exec setpriv --reuid=1000 --regid=1000 --init-groups ' +
              '/usr/local/bin/developer-shell\\n'));
          }
        } catch (error) {
          // Non-JSON status payload; ignore.
        }
      } else if (channel === SHELL_CHANNEL_HEARTBEAT) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(frame);
        }
      }
    });
    terminal.onData(function (data) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encodeStdinFrame(data));
      }
    });
  } catch (error) {
    showError(error);
  }
}

function closeTerminal() {
  el('terminal-dialog').close();
  if (terminalSocket) {
    terminalSocket.close(1000, 'Portal closing terminal');
    terminalSocket = undefined;
  }
  if (terminal) {
    terminal.dispose();
    terminal = undefined;
  }
}

function render() {
  var authenticated = signedIn();
  el('sign-in').hidden = authenticated;
  el('app').hidden = !authenticated;
  el('sign-out').hidden = !authenticated;
  var current = claims();
  el('who').textContent = authenticated && current ? (current.email || current.sub) : '';
  if (authenticated) { refresh(); }
}

el('start-session').addEventListener('click', startSession);
el('refresh').addEventListener('click', refresh);
el('terminal-close').addEventListener('click', closeTerminal);
el('sign-in').addEventListener('click', function () {
  login().catch(showError);
});
el('sign-out').addEventListener('click', signOut);

completeLogin()
  .then(render)
  .catch(showError);
`;
