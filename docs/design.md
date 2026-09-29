# Design

Melancholy is a minimal Slack-style workspace for people and agents.
Channels and direct messages are the primary navigation. Agent execution appears
inside the conversation. Controls use literal names: New message, Add member, Stop.

## Tokens

- Canvas and sidebar: `#f4f4f4`; conversation surface: `#ffffff`.
- Ink: `#202020`; secondary ink: `#707070`; rule: `#e8e8e8`.
- Dark mode uses a `#171717` frame, `#212121` conversation and `#292929` composer.
- Self-hosted Inter Variable for the interface and messages; IBM Plex Mono for code only.
- 13–14 px interface, 15 px conversation text, 14 px in the thread pane.
- 10–12 px navigation and controls, 18 px main surface, 24 px composer.
  Avatars remain 6 px rounded rectangles. Message rows remain flat.

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

The desktop references are the user’s ChatGPT app screenshots: a quiet gray
frame, softly selected navigation rows, a rounded white content surface and a
floating composer. A 248–256 px sidebar sits beside the main surface, with an
8 px outer gutter. Brand and conversation headers share a 52 px height.
Desktop navigation rows are 32 px high, with compact section labels and gaps.

Messages remain left aligned in a centered column up to 900 px wide. Body text
stays within 78 characters where possible. Keep the 2 px name-to-body gap and
use 10 px vertical row padding between messages. The composer shares the column width,
with a subtle shadow and circular send control. Preserve flat chronological
rows for people and agents. Unread conversations use weight and a small marker; mention counts appear
beside their names. A thread opens in a side pane while the channel stays mounted.
Threads also have a standalone page with a centered conversation column.
Pending messages appear immediately in italic without a sending label; failures
keep the message and expose Retry.
On a phone, navigation becomes a dismissible drawer and the thread uses the
full conversation area. Composer and member controls remain reachable.

## Review against the brief

Borrow the reference’s surface hierarchy and spacing, while preserving the
workspace’s channel, member and thread structure. Keep Inter and a grayscale
palette. Avoid copying macOS window controls or adding a decorative icon rail
without destinations. The one raised element in a conversation is its composer;
do not turn every message or settings row into another card.

No marketing hero, feature grid, gradient, sparkle icon, fictional activity,
or greetings. The sidebar uses the workspace name in small type; no large brand mark. The supplied wave SVG appears at 72 px beside the workspace
name and 90 px on the login page, with its original proportions and a neutral
light/dark fill. The source artwork is in `public/logo.svg`. The visual emphasis belongs to the content and the current action.
Agent details appear where they explain execution; infrastructure details stay
in server settings and documentation. Empty screens offer the next action.

Use shadcn primitives for focus, dialogs, menus, forms and message scrolling.
Verify actual screenshots in both themes and at a phone width before release.

## Settings

The account menu uses a 208 px popover with single-line Profile, Workspace and
Sign out entries, distinct icons and 36 px rows. Profile settings opens from it and contains avatar, display name,
username and password. Workspace settings has its own `/settings/workspace`
page and a narrow navigation column: General/Members, Integrations & credentials,
Bot & Agent, Usage. The content is left aligned with 24 px section headings, 36 px desktop insets,
icon-supported navigation, restrained dividers and focused forms. Credential creation and replacement use focused dialogs; values are never
shown after saving. On phones the category navigation scrolls horizontally.
The sidebar brand row starts at the shared surface edge, aligned with the
channel header, without an extra top padding band. On a phone, remove the
outer workspace gutter and retain a full-width conversation.

## Interaction motion

Desktop threads use shadcn Resizable, with pointer and keyboard adjustment and
browser-local width persistence. Motion adds a short opacity transition while
the channel and its composer stay mounted. Phone threads slide over the channel;
closing reveals the existing scroll position. Channel and content-tab navigation
uses a 180 ms View Transition where supported; the editor remains mounted.
Thread switches and settings navigation use a short opacity transition without
moving headings or replaying the whole message history. No idle animation loops.

Search, reply, settings and expand controls use locally installed icons from
[lucide-animated](https://lucide-animated.com). They respond across the button's
hit area and on keyboard focus; decorative icons have no separate tab stop.
The upstream MIT license is retained in `components/icons/LICENSE`.
Respect reduced motion for panel geometry, fades and icon movement. Thread
closing restores focus and exiting panes cannot receive keyboard input.
