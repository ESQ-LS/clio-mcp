# Privilege Stack: Self-Hosted Legal AI with Clio MCP

This directory contains configuration examples and an operational install guide for running Clio MCP with a **fully self-hosted local LLM** instead of cloud Claude. After the SDNY ruling in [*United States v. Heppner*](https://harvardlawreview.org/blog/2026/03/united-states-v-heppner/) (Feb 2026), consumer Claude is not protected by attorney-client privilege, and even Claude Enterprise sits in an "open question" zone per the court's dicta. This stack closes the question by removing every third-party processor.

For the full strategic context (why this matters, when to use it vs Claude Enterprise, hardware budget guidance), see the **[blog post](https://oktopeak.com/blog/privilege-stack-on-prem-legal-ai/)**. This README is the operational walkthrough.

---

## What you're building

```
┌─────────────────────┐    stdio    ┌──────────────────┐    HTTPS     ┌──────────────┐
│  LM Studio /        │ ◄─────────► │  Clio MCP        │ ◄──────────► │  Clio API    │
│  Continue + Ollama  │             │  (this connector)│              │  (cloud)     │
│                     │             │                  │              │              │
│  Local 70B model    │             │  Audit logger,   │              │  Your firm's │
│  (Llama 4 / DeepSeek│             │  AES-256 tokens  │              │  data        │
│   V4 / etc.)        │             │  on disk         │              │              │
└─────────────────────┘             └──────────────────┘              └──────────────┘
       │                                                                       │
       │  No traffic leaves your machine                                       │
       └───────────────────────────────────────────────────────────────────────┘
                              EXCEPT to Clio (which is required)
```

The only network traffic during a session is between the connector and `app.clio.com` (or your regional endpoint). **No Anthropic, OpenAI, or other AI provider ever sees your data.** Verify with `tcpdump` or Little Snitch — see the validation step at the end.

---

## Prerequisites

- **A Mac Studio with 128 GB unified memory** (M4 Max recommended) **OR** a Linux box with an NVIDIA GPU with 32 GB+ VRAM (RTX 5090). A 70B model at 4-bit quantization needs ~40-45 GB working memory.
- **Node.js 22.12 or later** for our connector.
- **A Clio account** with permission to create developer applications.
- **macOS, Windows, or Linux.** All three work.

---

## Path A: LM Studio (recommended — cleanest UX)

[LM Studio](https://lmstudio.ai) shipped native MCP support in v0.3.17 (July 2025). The April 2026 release (v0.4.11) added OAuth support and improved tool-call reliability.

### Step 1 — Install LM Studio

Download from [lmstudio.ai/download](https://lmstudio.ai/download). First launch downloads the runtime (~200 MB).

### Step 2 — Download Llama 4 70B

Open LM Studio's search tab. Search for `Llama-4-70B-Instruct-Q4_K_M`. Download (~40 GB, 30-60 min on a fast connection).

Alternatives to try after Llama 4 is working:
- `DeepSeek-V4-Pro` — top reasoning, MIT license
- `GLM-5` — best for coding-style work, Apache 2.0
- `Mistral-Large` — multilingual

### Step 3 — Install Clio MCP

```bash
npm install -g @oktopeak/clio-mcp
clio-mcp --version  # should print 1.0.1 or higher
```

### Step 4 — Register a Clio Developer App

Log in at [developers.clio.com](https://developers.clio.com), click **Add Application**:

- **Name:** Local Legal AI
- **Redirect URI:** `http://127.0.0.1:5678/callback` *(use 127.0.0.1, not localhost — Clio rejects localhost)*
- **Permissions:** Read on Activities, Billing, Calendars, Contacts, Documents, Users; Read+Write on Matters and Tasks

Save the **Client ID** and **Client Secret**.

### Step 5 — Generate an encryption key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the 64-character hex output. Store it in a password manager.

### Step 6 — Add Clio to LM Studio's MCP config

Open LM Studio Settings → MCP. Use the example file in this directory: [`configs/lm-studio.example.json`](configs/lm-studio.example.json). Replace placeholder values with your own Client ID, Client Secret, and encryption key.

Restart LM Studio.

### Step 7 — Authenticate

Open a chat with Llama 4 70B in LM Studio. Type:

> *"Authenticate with Clio."*

The model should call our `authenticate` tool. LM Studio will show a tool-call confirmation dialog — approve it. Your browser opens to Clio's OAuth page. Log in, authorize, and you're done. Tokens are encrypted with AES-256-GCM and stored locally at `~/.clio-mcp/tokens.enc`.

Confirm with:

> *"List my open matters."*

You should see your real Clio matters returned by the local model.

---

## Path B: Continue.dev + Ollama + bridge

If you'd rather use [Ollama](https://ollama.com) for inference (lighter daemon, easier to script), you'll need a bridge. Ollama doesn't speak MCP natively yet ([issue #7865](https://github.com/ollama/ollama/issues/7865) on Ollama).

### Bridge options

| Bridge | Language | Notes |
|--------|----------|-------|
| [`mcphost`](https://github.com/mark3labs/mcphost) | Go | Most mature. Recommended. |
| [`ollama-mcp-bridge`](https://github.com/patruff/ollama-mcp-bridge) | Node.js | Lighter, simpler config |
| [`mcp-client-for-ollama`](https://github.com/jonigl/mcp-client-for-ollama) | Python | TUI for developers |

### Quick setup with mcphost

```bash
# Install Go if you don't have it
brew install go  # macOS

# Install mcphost
go install github.com/mark3labs/mcphost@latest

# Pull a model into Ollama
ollama pull llama4:70b

# Configure servers — see configs/ollama-desktop-config.example.json in this directory
mcphost -m ollama:llama4:70b --config ~/.config/mcphost/servers.json
```

For the Continue.dev side, see [`configs/continue-dev.example.json`](configs/continue-dev.example.json) and the [Hugging Face MCP course](https://huggingface.co/learn/mcp-course/en/unit2/continue-client).

---

## Validation — the test that actually matters

The headline claim is "no third-party processor sees your data." Verify it.

### macOS: Little Snitch

Install [Little Snitch](https://obdev.at/products/littlesnitch/) (commercial, ~$45). Run a representative session: ask Llama to list matters, summarize a document, draft a task. Watch the connection log.

You should see:

- ✅ `app.clio.com` or `eu.app.clio.com` (Clio API)
- ✅ `127.0.0.1` connections (the local OAuth callback during initial auth)

You should **NEVER** see during a session:

- ❌ `*.anthropic.com`
- ❌ `api.openai.com`
- ❌ `*.azure.com`
- ❌ `*.aws.amazon.com`
- ❌ Any other AI provider domain

### Linux: tcpdump

```bash
sudo tcpdump -n -i any 'port 443' | grep -v 'app.clio.com\|127.0.0.1'
```

If anything other than Clio API traffic shows up during a Llama-driven Clio query, you have a leak. Investigate the model runtime's network configuration.

### Windows: Wireshark

Use Wireshark with a display filter `tls && ip.dst != [your Clio region IP range]`. Same expectation: zero non-Clio outbound traffic during a Llama session.

---

## Operational notes

### Audit log

Every Clio MCP tool call writes one JSON line to `~/.clio-mcp/audit.log`. The connector treats local LLMs identically to Claude — same tool calls, same audit format. ABA Opinion 512 retention requirements are met.

### Performance expectations

| Hardware | Model | Tokens/sec |
|----------|-------|------------|
| Mac Studio M4 Max 128 GB | Llama 4 70B Q4 | 10-15 |
| Mac Studio M3 Ultra 96 GB | Llama 4 70B Q4 | 12-15 |
| RTX 5090 32 GB + 64 GB RAM | Llama 4 70B Q4 (with offload) | 8-12 |
| Mac Studio M4 Max 64 GB | Llama 4 Scout (MoE, 17B active) | 30-50 |

### Updating

```bash
npm install -g @oktopeak/clio-mcp@latest
```

Pin to a specific version in production: `@oktopeak/clio-mcp@1.0.1`. Audit the diff before upgrading. See the [Trust Model](../../README.md#trust-model) section in the main README for supply-chain guidance.

---

## When this stack isn't the right fit

- **Highly long-context legal research** (200K+ tokens of case law in a single prompt). Claude Enterprise still has the edge here.
- **Frontier reasoning at the edge of model capability** (very complex multi-step contract analysis). DeepSeek V4 is close but Claude Opus is still ahead in early 2026.
- **Multi-jurisdictional or unusual-language work.** Frontier hosted models have more multilingual training data.

For these cases, use Claude Enterprise with ZDR. Many firms run both: privilege stack for sensitive work, hosted Claude for general productivity. Our Clio MCP works with both.

---

## Need help?

We deploy this stack for firms that want it operational without the in-house engineering work. See [oktopeak.com/services/legal-ai-integration/](https://oktopeak.com/services/legal-ai-integration/) for the service.

Issues or questions about the open-source connector: file at [github.com/oktopeak/clio-mcp/issues](https://github.com/oktopeak/clio-mcp/issues).
