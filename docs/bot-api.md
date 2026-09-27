# Bot API

Create a bot in **Settings → Integrations**, add it to the intended channel
through the channel's member settings, then create an API token or incoming
webhook. A server connection also creates a bot identity. Only the workspace
owner can create bots and credentials.

## Authentication and scopes

Use `Authorization: Bearer TOKEN` with `/api/v1/*`. Tokens can access only the
bot's joined conversations, optionally narrowed to a single conversation.
Public channels do not grant bots implicit access. The author is always the
credential's bot; request fields cannot override it.

JSON requests and responses use UTF-8. Errors have an `error` string and an
appropriate HTTP status. `401` means invalid credentials; `404` also covers
conversations and messages outside the credential's scope.

## Conversations and messages

```sh
curl https://your-workspace.example/api/v1/rooms \
  -H 'Authorization: Bearer TOKEN'

curl https://your-workspace.example/api/v1/rooms/ROOM_ID/messages \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"id":"CLIENT_GENERATED_UUID","text":"Build **passed**."}'
```

Supply a stable client UUID to make a retried send idempotent. The response
contains `message` and `duplicate`. `parentId` replies to a root message in the
same conversation. Text is limited to 32,000 characters.

| Method | Path                                        | Purpose                                                     |
| ------ | ------------------------------------------- | ----------------------------------------------------------- |
| GET    | `/api/v1/rooms`                             | List accessible conversations and their members             |
| GET    | `/api/v1/rooms/:id/messages`                | Latest 100 root messages                                    |
| GET    | `/api/v1/rooms/:id/messages?before=SEQ`     | Earlier history                                             |
| GET    | `/api/v1/rooms/:id/messages?parent=ROOT_ID` | Thread replies; also accepts `before`                       |
| POST   | `/api/v1/rooms/:id/messages`                | Post `{id?, text, parentId?, attachments?}`                 |
| GET    | `/api/v1/messages/:id`                      | Read one message                                            |
| PATCH  | `/api/v1/messages/:id`                      | Edit the bot's own message with `{text}`                    |
| DELETE | `/api/v1/messages/:id`                      | Delete the bot's own message                                |
| PUT    | `/api/v1/messages/:id/reactions`            | Add `{emoji}` idempotently                                  |
| DELETE | `/api/v1/messages/:id/reactions`            | Remove that bot's `{emoji}`                                 |
| GET    | `/api/v1/search?q=QUERY`                    | Search within the bot's scope                               |
| POST   | `/api/v1/files?room=ROOM_ID`                | Upload multipart `file`                                     |
| GET    | `/api/files/:id`                            | Download a permitted attachment using the same bearer token |

Upload first, then pass the returned file IDs in `attachments`. Files are
limited to 10 MB each and eight per message. Draft files belong to the uploader;
a bot cannot attach another member's unposted file.

Mention a conversation member using `@username` in message text. A mention must
refer to an active member of that conversation to generate a mention count.
Messages from bots never automatically invoke connected agents.

## Incoming webhooks

A webhook URL is bound to one bot and one conversation. POST a message body:

```sh
curl https://your-workspace.example/api/hooks/WEBHOOK_SECRET \
  -H 'Content-Type: application/json' \
  -d '{"text":"Deployment complete."}'
```

It accepts the same message fields, including an optional idempotency `id` and
`parentId`. Keep the entire URL private. Revoke it in Settings to stop delivery.
A webhook cannot choose a different conversation or author.

## Receiving events

```sh
curl 'https://your-workspace.example/api/v1/events?after=0' \
  -H 'Authorization: Bearer TOKEN'
```

The result contains up to 100 `events` and a `cursor`. Each event has `seq`,
`room_id`, `message_id`, `type` and `created_at`. Fetch the message separately to
read its latest authorized state. Types include `message.created`,
`message.updated`, `message.deleted` and `reaction.updated`.

Persist the cursor after handling the batch and supply it as `after` on the
next poll. Retry failures with backoff and deduplicate by event `seq`. An edit
can arrive after the original event, so fetching a message returns its current
state. Events are filtered by current membership and token scope. The event
API uses polling; outbound HTTP event subscriptions are not implemented.

## Connecting Codex or Claude Code

Use the [server connector](../packages/connector/README.md) for an existing CLI.
Its credential and outbound WebSocket protocol are separate from the Bot API.
A channel mention starts a reply in that message's thread. Mention the bot in a
subsequent thread reply to resume. Direct messages to an agent bot resume the
same CLI session across turns. Queued turns wait while that connector is offline.
