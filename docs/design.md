# Design

Melancholy is a minimal Slack-style workspace for people and agents.
Channels and direct messages are the primary navigation. Agent execution appears
inside the conversation. Controls use literal names: New message, Add member, Stop.

## Tokens

- Paper: `#fafafa`; surface: `#ffffff`; sidebar: `#f2f2f2`.
- Ink: `#202020`; secondary ink: `#707070`; rule: `#e5e5e5`.
- Dark mode uses the same neutral scale: `#151515`, `#1c1c1c`, `#282828`.
- IBM Plex Sans for the interface and messages; IBM Plex Mono for code only.
- 14 px interface and conversation text, 13 px in the thread pane.
- 6 px control radius. Flat message rows, no floating message cards.

## Layout

```text
┌──────────────────────┬─────────────────────────────┬─────────────────────┐
│ melancholy           │ # engineering        Search │ Thread            × │
│ async.love           ├─────────────────────────────┼─────────────────────┤
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
On a phone, navigation becomes a dismissible drawer and the thread uses the
full conversation area. Composer and member controls remain reachable.

## Review against the brief

No marketing hero, feature grid, gradient, sparkle icon, fictional activity,
or greetings. The brand is a quiet lowercase wordmark with a compact drawn
symbol. The visual emphasis belongs to the content and the current action.
Agent details appear where they explain execution; infrastructure details stay
in server settings and documentation. Empty screens offer the next action.

Use shadcn primitives for focus, dialogs, menus, forms and message scrolling.
Verify actual screenshots in both themes and at a phone width before release.
