---
description: Set this session's Steerline project when the folder resolves to none
argument-hint: <project id>
---

This session's folder is not attached to a Steerline project, or the person wants another one. Connect this session to the project `$ARGUMENTS`:

1. Call the platform's `register_session` tool with `project` set to `$ARGUMENTS` (leave `session_id` empty; the plugin's hook attaches this session's id and remembers the project for the rest of the session).
2. Call `get_brief` with the same project and follow the protocol in it: declare your intent before you change anything, ask with `ask_guidance`, record your outcome before you end.

If `$ARGUMENTS` is empty, ask the person which project with the platform's `ask_guidance` tool; if they want this folder attached for good, tell them to attach the repository on their Steerline's Repositories page (`<address>/enroll`).
