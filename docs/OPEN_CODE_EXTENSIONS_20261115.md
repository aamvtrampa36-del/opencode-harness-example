# OpenCode Cloud extensions — 2026-11-15

## Models and images

Each editable template has a primary model, an optional decision model, and an optional image-generation override. The primary model handles the task. A decision model is used only when a subagent is explicitly started with `kind: "decision"`; ordinary analysis inherits the parent session model. Choose the owner's default image model in **Settings → Modelos**; it saves immediately and is ready from the chat's **Generar imagen** action. A selected template can override that default. The image model is used only by the `generate_image` tool when the prompt asks for image creation.

Image analysis accepts up to two PNG, JPEG, or WebP files, each up to 2 MB. Select an OpenRouter model marked as image-compatible before sending them. Image generation uses OpenRouter's [image model catalogue](https://openrouter.ai/models?output_modalities=image) and [image generation endpoint](https://openrouter.ai/docs/guides/overview/multimodal/image-generation); OpenRouter may charge for calls. No image model is selected by default.

## Delegated work

`start_subagent` creates a read-only child of the current conversation. It inherits the approved project and repository scope; project sessions use their existing scoped Linux and GitHub read tools. A child cannot create more children. Up to three children can be running and eight may be created per parent conversation. Use `subagent_result` with the returned session ID to poll for its summary.

## Hooks and TokenEconomizer

Optional connectors use a small normalized event adapter for session start, prompt, tool result, turn end, and session end. Connector failures fail open so a hook cannot stop a chat turn.

In **Settings → Conectores y hooks**, the owner can install and enable TokenEconomizer. The installer checks out the official repository at commit `7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0` in a separate Cloudflare Container. This OpenCode adaptation enables only the model-free `envfacts` micro-skill. Loop guarding, tool pruning, repository maps, and paid side calls remain off because they require capabilities or extra model calls that are not part of this adapter. Hook state is separate from Linux project files and follows the Container snapshot lifecycle.
