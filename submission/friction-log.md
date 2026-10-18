# HomeKeeper · Friction log

What we tried while building HomeKeeper for Alexa+, where it got stuck, and what would fix it. Every entry comes from our build notes ([RESEARCH_AND_PLAN.md](../RESEARCH_AND_PLAN.md), [VERIFICATION.md](../VERIFICATION.md)).

| # | Friction | Severity |
| --- | --- | --- |
| 1 | Connecting HomeKeeper's MCP server to Alexa+ | High |
| 2 | No way to test an add-on locally | High |
| 3 | Account linking is heavy for private household data | Medium |
| 4 | Tool changes need redeployment | Low |
| 5 | No design kit for Alexa+ surfaces | Low |

## 1. Connecting HomeKeeper's MCP server to Alexa+ (severity: High)

- **Task:** plug HomeKeeper's existing MCP tools (save item, care review, repairs, storage location, 3D link) into Alexa+ as an add-on.
- **Steps:** read the Alexa+ MCP Toolkit overview and quickstart, built the MCP server on Streamable HTTP, then looked for a way to register it.
- **Expected:** a developer sandbox where a working MCP server can be registered and called by Alexa+.
- **Actual:**
  - Add-on onboarding needs account onboarding, a publicly reachable URL and account linking.
  - The toolkit is listed as US-only.
  - We had no Alexa+ add-on access, so the MCP server could never be called by real Alexa+.
- **Workaround:** we built our own local agent host that calls the same MCP tools, and labelled it honestly as "Alexa+ Simulate".
- **Suggestion:**
  - An open developer preview or sandbox for Alexa+ add-ons, available outside the US.
  - A way to point Alexa+ at a dev endpoint (a tunnel) before full onboarding.

## 2. No way to test an add-on locally (severity: High)

- **Task:** check that Alexa+ chooses the right tool, passes all declared inputs, and renders our data-only responses well.
- **Steps:** built the tools following "Tools and data design", then looked for a simulator or test console.
- **Expected:** a local or console simulator that shows which tool Alexa+ picks and how it renders the response.
- **Actual:**
  - Testing needs a remote URL and full onboarding.
  - Amazon renders data-only responses natively, but we couldn't preview that rendering.
- **Workaround:** we wrote our own agent loop and React UI to exercise the tools, plus browser regression tests with a mocked provider.
- **Suggestion:** an Alexa+ add-on test console, like the Alexa Skills Kit simulator, for MCP tools: tool-choice trace, inputs and rendered output.

## 3. Account linking is heavy for private household data (severity: Medium)

- **Task:** keep each household's records private when Alexa+ calls the tools.
- **Steps:** read the account-linking requirements for private data.
- **Expected:** a lightweight dev-mode auth to prototype with.
- **Actual:**
  - Private, account-linked integration needs OAuth 2.1 with PKCE plus protected-resource metadata.
  - Our local bearer token does not count as Amazon account linking.
- **Workaround:** kept HomeKeeper local, single-household and loopback-only, with a local token.
- **Suggestion:** a dev-mode or test account-linking flow, and a reference OAuth 2.1 + PKCE server template for MCP add-ons.

## 4. Tool changes need redeployment (severity: Low)

- **Task:** iterate on tool names and schemas while designing them.
- **Steps:** read the toolkit overview.
- **Expected:** hot reload of tool definitions in development.
- **Actual:** per the docs, any tool change needs a redeployment.
- **Workaround:** froze the tool contract early and iterated behind it in our own host.
- **Suggestion:** hot-reloaded tool definitions for dev endpoints.

## 5. No design kit for Alexa+ surfaces (severity: Low)

- **Task:** make HomeKeeper's companion UI feel at home next to Alexa+.
- **Steps:** looked for official design guidance, components or fonts for Alexa+ web and desktop.
- **Expected:** a published design kit (colours, type, components).
- **Actual:** nothing published. We studied the signed-in alexa.amazon.com desktop through screenshots and its rendered styles: layout sizes, the composer and the Alexa Sans font.
- **Workaround:**
  - Rebuilt the look by hand.
  - Used an original HomeKeeper mark, not Amazon's logo, and made no affiliation claim.
- **Suggestion:** publish an Alexa+ design kit (tokens, components, font licensing) for add-on companion experiences.
