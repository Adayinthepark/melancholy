# Design

Melancholy is a minimal Slack-style workspace for people and agents.
Channels and direct messages are the primary navigation. Agent execution appears
inside the conversation. Controls use literal names: New message, Add member, Stop.

## Tokens

- Paper: `#fafafa`; surface: `#ffffff`; sidebar: `#f2f2f2`.
- Ink: `#202020`; secondary ink: `#707070`; rule: `#e5e5e5`.
- Dark mode uses the same neutral scale: `#151515`, `#1c1c1c`, `#282828`.
- Self-hosted Inter Variable for the interface and messages; IBM Plex Mono for code only.
- 14 px interface and conversation text, 13 px in the thread pane.
- 6 px control and avatar radius; avatars are rounded rectangles. Flat message rows, no floating message cards.

## Layout

```text
┌──────────────────────┬─────────────────────────────┬─────────────────────┐
│ async.love           │ # engineering        Search │ Thread            × │
│                      ├─────────────────────────────┼─────────────────────┤
│ New message          │                             │ Original message    │
│                      │ Name              14:02     │                     │
│ Channels           + │ Message                     │ Name        14:03   │
│ # general            │ 👍 2     3 replies          │ Reply               │
│ # engineering        │                             │                     │
│                      │ Agent                       │                     │
│ Direct messages    + │ Reply / tool activity       │                     │
│ Name                 │                             │                     │
│ Group                │                             │                     │
│                      │ ┌─────────────────────────┐ │ ┌─────────────────┐ │
│                      │ │ Message #engineering    │ │ │ Reply in thread │ │
│ Profile / Settings   │ │ Attach   @        Send  │ │ │ Attach  @  Send │ │
└──────────────────────┴─┴─────────────────────────┴─┴─┴─────────────────┴─┘
```

Left aligned, with a narrow persistent sidebar and flat chronological message
rows. Unread conversations use weight and a small marker; mention counts appear
beside their names. A thread opens in a side pane without moving the channel.
Threads also have a standalone page with a centered conversation column.
Pending messages appear immediately in italic with a sending label; failures
keep the message and expose Retry.
On a phone, navigation becomes a dismissible drawer and the thread uses the
full conversation area. Composer and member controls remain reachable.

## Review against the brief

No marketing hero, feature grid, gradient, sparkle icon, fictional activity,
or greetings. The sidebar uses the workspace name in small type; no large brand mark. The supplied wave SVG appears at 72 px beside the workspace
name and 90 px on the login page, with its original proportions and a neutral
light/dark fill. The source artwork is in `public/logo.svg`. The visual emphasis belongs to the content and the current action.
Agent details appear where they explain execution; infrastructure details stay
in server settings and documentation. Empty screens offer the next action.

Use shadcn primitives for focus, dialogs, menus, forms and message scrolling.
Verify actual screenshots in both themes and at a phone width before release.

## Settings

Profile settings opens from the account menu and contains avatar, display name,
username and password. Workspace settings has its own `/settings/workspace`
page and a narrow navigation column: General/Members, Integrations & credentials,
Bot & Agent, Usage. The content is left aligned with forms and simple divided
rows. Credential creation and replacement use focused dialogs; values are never
shown after saving. On phones the category navigation scrolls horizontally.
The sidebar brand row starts at the top edge, aligned with the channel header,
without an extra top padding band.

## Interaction motion

Use Motion for a 240 ms thread expansion/collapse, keeping the channel mounted
and the thread text at its final width to avoid squeezing every line. Phone
threads slide over the channel; closing reveals the existing scroll position.
Thread switches and settings navigation use a short opacity transition without
moving headings or replaying the whole message history. No idle animation loops.

Search, reply, settings and expand controls use locally installed icons from
[lucide-animated](https://lucide-animated.com). They respond across the button's
hit area and on keyboard focus; decorative icons have no separate tab stop.
The upstream MIT license is retained in `components/icons/LICENSE`.
Respect reduced motion for panel geometry, fades and icon movement. Thread
closing restores focus and exiting panes cannot receive keyboard input.
