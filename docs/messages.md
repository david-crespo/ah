# Messages

Everything `ah` sends an agent is plain text. It appears to the agent as if you typed it. Some harnesses inject extra text warning the agent about prompt injection. The agent answers by editing a file, which the open page picks up on its own, or by running `ah message respond`, which the page shows as a chat reply. This doc covers each message format.

## Delivery mechanism

- **Claude Code**: one line of JSON written to the session's inbox socket, `{"type":"user","message":{"role":"user","content":"<text>"}}`.
- **Codex**: `codex queue --thread <id> --message "<text>"`.
- **OpenCode**: a POST to `/api/session/<id>/prompt` on OpenCode's background service.

## Requests from a page

Requests from a page (comments, chat messages, Go buttons) belong to a thread, with one thread per file. Each message sent to the agent has a header line, any context lines, and then one line per request:

```
Markdown requests for /Users/david/repos/ah/README.md (handle per /markdown skill):
Request 22e00d40-34dd-4d34-a7f7-1f04315e1416: a comment on the passage "a session ID":
accurate?
```

The header tells the agent which file the message is for and which agent skill says how to handle it. The header starts with `Markdown` for a markdown file or `HTML` for an HTML page or task tracker. It appends `, port <n>` inside the parentheses when the server isn't on the default port (`subjects/thread/thread.ts`).

Each request starts with `Request <id>: `, or `Request <id>, answering <earlier id>: ` when you're replying to a question from the agent. The agent passes that request ID back to `ah message respond`.

The rest of the request depends on its kind (`subjects/thread/kinds.ts`, `views/html/requests.ts`):

| Kind           | From                            | What the agent reads                                                                                                   |
| -------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `chat`         | the conversation panel          | the text                                                                                                               |
| `comment`      | a selection                     | `a comment on the passage "<selection>" (after "<prefix>", before "<suffix>"):` and the text on the next line          |
| `dellm`        | a selection's de-LLM button     | `de-LLM the passage "<selection>" (...): rewrite it to sound like a person`, then `. Guidance: <text>` if there is any |
| `go`           | a tracker item's Go button      | `Go ahead with item <id>: <title>`                                                                                     |
| `item-comment` | a tracker item's comment button | `a comment on item <id>: <title>`, a blank line, then the text                                                         |

Selections are quoted from the rendered text, not the source, with up to 60 characters of surrounding context (`<prefix>` and `<suffix>`) on each side to tell repeated passages apart. If the selection is inside an embed, like a code snippet from a GitHub permalink, the request adds `in the embed of <url>` after the passage.

### Edit notices

On a markdown file, a request can be preceded by a context line describing how the file changed on disk since the last request. This covers both your own saves in Helix and the agent's edits (`views/markdown/doc.ts`):

```
Edit notice: since the last request, the file on disk replaced "<old>" with "<new>" after "<40 characters before>"
```

The text is JSON-quoted so the notice stays on a single line. If a change only adds or removes text, the notice uses `inserted` or `deleted` instead of `replaced`.

### Held requests

Each file is bound to the agent that opened its page with `ah view open`. When you open a page from a shell in Rex instead, it uses the pane's existing agent pick or the tab's only agent; if there are several and no pick, it asks you to choose. Requests go to that agent. In Rex, the binding follows the agent through `/clear` or a restart in its pane. If it's gone, requests go to another live agent in its tab.

If you submit a request when no agent is reachable, the request waits in the thread's log and the page tells you it's held. Once an agent connects, or another agent runs `ah view open` on the file and so binds it, requests still waiting that have never been delivered are sent together in a single message, oldest first. Requests already delivered and interrupted work aren't automatically resent; an agent can find them with `ah message pending <file>`.

## Comments sent to a tab

`ah message send` sends a message to an agent running in the current Rex terminal tab. This is how Helix's comment command talks to the agent ([helix.md](helix.md)). If the tab has several agents, the message goes to the one named with `--agent` (an ID from `ah workspace agents`), which also becomes the pane's pick for later sends. Without `--agent`, it goes to the pane's pick. With neither, the command refuses and lists the agents. The comment text comes from `--text`, `--text-file`, or stdin. The message starts with a line telling the agent where the message came from. If `--file` is passed, the next line says where the comment is located (`core/core.ts`, `subjects/thread/cli.ts`):

````
From the user, through ah: treat it as typed here and answer in the terminal, not with SendMessage.

A comment from the user on lines 12-14 of /Users/david/repos/ah/README.md, selecting:
```
<the selected text>
```

<the comment>
````

The first line is there because Claude Code agents have a `SendMessage` tool for messaging other sessions, and might otherwise answer a message that came in on the inbox socket with it. Without `--lines`, the location line gives only the file path. Without `--selection`, that line ends in a colon and the comment follows after a blank line, with no code block. If there's no agent in the tab yet, the message is held until one starts there.

Outside of Rex, `--agent` sends directly to that agent without requiring `--file`. Without `--agent`, `--file` is required, and the comment goes into the file's thread. It becomes a `comment` request if there's a selection or line range, or a `chat` request if there isn't. A selection is quoted as given. With only `--lines`, the quote is the text of those lines.

## Replies from the agent

To reply to a thread, the agent runs:

```
ah message respond <file> <phase> [request ids...] [--text <text> | --text-file <path>] [--work <id>]
```

`<file>` identifies the thread, and the server broadcasts the reply to every open page for that file. `<phase>` controls how the reply shows up in the UI:

| Phase         | Means                                                                          | Text     |
| ------------- | ------------------------------------------------------------------------------ | -------- |
| `start`       | working on it; the page shows a spinner                                        | optional |
| `progress`    | an update while working                                                        | optional |
| `reply`       | a message that doesn't end the work, or, with no request IDs, a standalone one | required |
| `done`        | finished                                                                       | optional |
| `needs-reply` | waiting on your answer; the page shows a question mark                         | required |
| `error`       | can't go on                                                                    | required |

A request's status comes from its latest phase: `waiting` until `start`, then `working`, and finally `done`, `needs-reply`, or `error`. Once a request is `done`, it won't accept any more phases. If the server restarts while a request is still `working`, the server marks it as `interrupted`.

Each run of work on one or more requests has a work ID, which defaults to `w-<first request id>` or can be set with `--work`. Any phase after `start` must pass the same work ID that started it. For `progress`, `done`, `needs-reply`, and `error`, the CLI sends `start` first if needed, so quick tasks can jump straight to `done`. A `reply` tied to a request needs work already started; a standalone `reply` doesn't.

`ah message pending <file>` prints unfinished requests as one JSON object per line, including `status`. A new session can run it to pick up an existing thread.

## The log

Each thread is stored as an append-only JSON Lines file in `~/.local/state/ah/<markdown|html>/`, named after the file's absolute path with slashes replaced by dashes and ending in `.comments.jsonl` (`subjects/thread/events.ts`). It holds the conversation history that pages show. A new agent session can read it to catch up, but doesn't receive that history automatically. There are three record types:

```json
{"type":"request","kind":"comment","text":"accurate?","args":{"selection":"a session ID"},"id":"22e00d40-…","seq":176,"at":"2026-10-26T18:44:10.101Z"}
{"type":"delivered","requests":["22e00d40-…"],"at":"2026-10-26T18:44:10.104Z"}
{"type":"activity","phase":"done","requests":["22e00d40-…"],"workId":"w-22e00d40-…","text":"Close. …","id":"…","seq":177,"at":"2026-10-26T18:44:40.552Z"}
```

`delivered` records track which requests have actually been sent to an agent, so held requests aren't lost if the server restarts.

## HTTP

The main API and markdown pages run on `http://127.0.0.1:7420`. HTML pages are served on `http://127.0.0.1:7421`. Their scripts send requests to the page endpoints there; the API on 7420 rejects requests from that origin. If you set a custom server port, the HTML server uses the next port up.

### A button that talks to the agent

Once you have the hooks and HTML skill installed ([setup](setup.md)), ask the agent to save this as `hello/index.html` in its workspace. Put the page in its own directory, since `ah` reloads the page whenever any file in that directory changes.

```html
<!doctype html>
<meta charset="utf-8" />
<title>Hello ah</title>
<main>
  <button id="hello">Say hello</button>
  <p id="status"></p>
</main>
<script type="module">
  const button = document.querySelector("#hello")
  const status = document.querySelector("#status")
  button.addEventListener("click", async () => {
    button.disabled = true
    try {
      const response = await fetch("_ah/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "chat", text: "Say hello in this page's chat." }),
      })
      if (!response.ok) throw new Error(await response.text())
      const { agentConnected } = await response.json()
      status.textContent = agentConnected ? "Sent" : "Waiting for an agent"
    } catch (error) {
      status.textContent = String(error)
    } finally {
      button.disabled = false
    }
  })
</script>
```

Then have the agent run:

```sh
ah view open hello/index.html
```

This registers the file, binds it to that agent, and opens the page. The printed URL contains a signed page ID, so use the URL `ah` prints rather than trying to construct an ID from the filename. Inside the page, the relative `_ah/request` URL resolves against port 7421. `ah` injects the chat panel and its WebSocket connection for replies automatically.

Click **Say hello**. The POST returns a `request` object with an `id`, along with `agentConnected` to indicate whether it reached the agent. The agent receives:

```text
HTML requests for /path/to/workspace/hello/index.html (handle per /html skill):
Request <request-id>: Say hello in this page's chat.
```

The agent can reply by running the command below with the `<request-id>` it received. The reply shows up in the page's chat history. When using the CLI, `done` automatically starts the work if it isn't already running.

```sh
ah message respond hello/index.html done <request-id> --text 'Hello!'
```

### Page endpoints

| Origin                  | Endpoint                           | Purpose                                         |
| ----------------------- | ---------------------------------- | ----------------------------------------------- |
| `http://127.0.0.1:7420` | `POST /view/markdown/<id>/request` | Submit a markdown page request.                 |
| `http://127.0.0.1:7421` | `POST /view/html/<id>/_ah/request` | Submit an HTML page request.                    |
| `ws://127.0.0.1:7420`   | `/view/markdown/<id>/doc`          | Receive document changes and thread updates.    |
| `ws://127.0.0.1:7421`   | `/view/html/<id>/_ah/socket`       | Receive page reload notices and thread updates. |

Both request endpoints take chat messages and selection comments. For example:

```json
{
  "kind": "comment",
  "text": "Can you clarify this?",
  "args": { "selection": "a session ID" }
}
```

`kind` is required. `chat` requires `text`, and `comment` also requires `args.selection`. The other request kinds are listed under [Requests from a page](#requests-from-a-page); `go` and `item-comment` only work on HTML pages. `replyTo` is optional and names the earlier request you're answering. Successful requests return `request` and `agentConnected`, just like in the button example.

The WebSockets send a snapshot on connect and whenever the thread changes: `type` is `"thread"`, `file` is the absolute path, `entries` is the conversation history, and `requests` holds the current request states. `agentConnected` indicates whether the bound agent is reachable, and `replay` is true on the initial snapshot. On HTML pages, `ah`'s injected script already listens to this socket and dispatches an `ah-thread` event on `document` with the snapshot in `event.detail`.

### API endpoints

These endpoints run on `http://127.0.0.1:7420` for the CLI and other local tools; scripts on HTML pages can't call them. `<kind>` is `markdown` or `html`, and `<file>` is a URL-encoded absolute path.

| Endpoint                                      | Purpose                                                                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /view/<kind>/files`                     | Register a file and bind it to an agent. This is what `ah view open` calls; see `ShowRequest` in [subjects/files/routes.ts](../subjects/files/routes.ts) for the body. Returns the file's `id`, `url`, and binding information. |
| `GET /view/<kind>/files`                      | List files currently shown, including their IDs and URLs.                                                                                                                                                                       |
| `POST /view/<kind>/files/request?path=<file>` | Submit the same request JSON as a page, by file path. Returns `request` and `agentConnected`.                                                                                                                                   |
| `GET /view/<kind>/files/thread?path=<file>`   | Read the thread's requests and history.                                                                                                                                                                                         |
| `POST /view/<kind>/files/thread?path=<file>`  | Record agent activity: `phase`, `requests`, `workId`, and optional `text`, as described under [Replies from the agent](#replies-from-the-agent).                                                                                |
| `POST /core/send`                             | Send a plain message using `block` (the sender's `REX_BLOCK`), `agent` (an explicit agent ID, or null), and `text`. With no explicit agent, uses the pane's selection or the tab's only agent.                                  |

If you post activity for a request directly over HTTP, supply a `workId` and send `start` before posting updates or completing it. First, POST `start` to the file's thread endpoint:

```json
{ "phase": "start", "requests": ["<request-id>"], "workId": "w1" }
```

Then finish the work using the same `workId`:

```json
{ "phase": "done", "requests": ["<request-id>"], "workId": "w1", "text": "Hello!" }
```

Request kinds and fields are defined in [subjects/thread/kinds.ts](../subjects/thread/kinds.ts) and [views/html/requests.ts](../views/html/requests.ts), and activity validation is in [subjects/thread/events.ts](../subjects/thread/events.ts).
