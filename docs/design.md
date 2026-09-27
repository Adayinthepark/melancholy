# Design

Melancholy is a shared place to work with agents running on your own machines.
The conversation is the interface. The running task is visible without becoming
a dashboard. Controls use literal names: New thread, Connect server, Stop.

## Tokens

- Paper: `#fafafa`; surface: `#ffffff`; sidebar: `#f2f2f2`.
- Ink: `#202020`; secondary ink: `#707070`; rule: `#e5e5e5`.
- Dark mode uses the same neutral scale: `#151515`, `#1c1c1c`, `#282828`.
- IBM Plex Sans for the interface and messages; IBM Plex Mono for code only.
- 14 px interface, 15 px conversation, 20 px thread title.
- 6 px control radius. Flat message rows, no floating message cards.

## Layout

```text
┌──────────────────────┬──────────────────────────────────────────┐
│ melancholy           │ # channel                 Search   Theme │
│ async.love           ├──────────────────────────────────────────┤
│                      │                                          │
│ New thread           │ Thread title                             │
│                      │                                          │
│ Channels             │ You                       14:02          │
│ # general            │ Message                                  │
│ # engineering        │                                          │
│                      │ Codex                     14:03          │
│ Threads              │ Response and expandable tool activity    │
│ Recent conversation  │                                          │
│                      │                                          │
│ Servers              │                                          │
│ workstation          │ ┌──────────────────────────────────────┐ │
│                      │ │ Reply                                │ │
│ Settings             │ │ Attach       agent / server     Send │ │
└──────────────────────┴─┴──────────────────────────────────────┴─┘
```

Left aligned. Thread history is the dominant surface. The narrow sidebar is
navigation, not a second inbox. On a phone it becomes a dismissible drawer.

## Review against the brief

No marketing hero, feature grid, gradient, sparkle icon, fictional activity,
or greetings. The brand is a quiet lowercase wordmark with a compact drawn
symbol. The visual emphasis belongs to the content and the current action.
Agent details appear where they explain execution; infrastructure details stay
in server settings and documentation. Empty screens offer the next action.

Use shadcn primitives for focus, dialogs, menus, forms and message scrolling.
Verify actual screenshots in both themes and at a phone width before release.
