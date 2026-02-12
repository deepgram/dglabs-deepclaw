import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, Block } from "./types.js";
import { renderPage } from "./render.js";

// Resolved at service start from ctx.workspaceDir (the real path inside Docker)
let resolvedWorkspaceDir: string | undefined;

function getPagesDir(): string {
  const workspaceDir =
    resolvedWorkspaceDir ??
    process.env.OPENCLAW_WORKSPACE_DIR ??
    join(process.env.HOME ?? "/tmp", ".openclaw", "workspace");
  return join(workspaceDir, ".pages");
}

async function ensurePagesDir(): Promise<string> {
  const dir = getPagesDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

async function loadPage(id: string): Promise<Page | null> {
  const dir = getPagesDir();
  try {
    const raw = await readFile(join(dir, `${id}.json`), "utf-8");
    return JSON.parse(raw) as Page;
  } catch {
    return null;
  }
}

async function savePage(page: Page): Promise<void> {
  const dir = await ensurePagesDir();
  await writeFile(join(dir, `${page.id}.json`), JSON.stringify(page, null, 2), "utf-8");
}

// Normalize agent-provided blocks to match our expected shape.
// LLMs send variations like "pairs" vs "items", "description" vs "body", etc.
function normalizeBlock(raw: Record<string, unknown>): Block {
  const b = { ...raw } as Record<string, unknown>;
  const type = b.type as string;

  // Normalize label from "title" field when label is missing
  if (!b.label && b.title && type !== "hero") {
    b.label = b.title;
    delete b.title;
  }

  switch (type) {
    case "cards": {
      const items = (b.items ?? b.cards ?? []) as Record<string, unknown>[];
      b.items = items.map((c) => ({
        title: c.title ?? c.name ?? "",
        body: c.body ?? c.description ?? c.text ?? c.content ?? "",
        icon: c.icon ?? c.emoji,
        link: c.link ?? c.url,
      }));
      break;
    }
    case "key-value": {
      const items = (b.items ?? b.pairs ?? b.entries ?? []) as Record<string, unknown>[];
      b.items = items.map((kv) => ({
        key: kv.key ?? kv.label ?? kv.name ?? "",
        value: kv.value ?? kv.val ?? "",
      }));
      break;
    }
    case "table": {
      b.headers = b.headers ?? b.columns ?? [];
      b.rows = b.rows ?? b.data ?? [];
      break;
    }
    case "list": {
      const items = (b.items ?? b.entries ?? []) as Record<string, unknown>[];
      b.items = items.map((li) =>
        typeof li === "string"
          ? { text: li }
          : { text: li.text ?? li.label ?? String(li), checked: li.checked },
      );
      break;
    }
    case "markdown": {
      b.content = b.content ?? b.text ?? b.body ?? b.markdown ?? "";
      break;
    }
    case "html": {
      b.content = b.content ?? b.html ?? b.text ?? b.body ?? "";
      break;
    }
  }

  return b as unknown as Block;
}

function normalizeBlocks(blocks: Record<string, unknown>[]): Block[] {
  return blocks.map(normalizeBlock);
}

function getBaseUrl(): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  const port = process.env.OPENCLAW_GATEWAY_PORT ?? "18789";
  return `http://localhost:${port}`;
}

export default {
  id: "page-builder",
  name: "Page Builder",

  register(api: OpenClawPluginApi) {
    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "page_create",
        label: "Page Create",
        description:
          "Create a rich visual page when the user asks for something that benefits from structured layout — " +
          "briefings, reports, research, dashboards, comparisons, schedules. " +
          "For simple answers, just reply in chat. Returns the page URL to share with the user.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Page title" },
            subtitle: { type: "string", description: "Optional subtitle" },
            blocks: {
              type: "array",
              description: "Array of content blocks",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    description:
                      "Block type: hero, cards, key-value, table, list, markdown, html (raw HTML for interactive content like games/widgets)",
                  },
                },
                required: ["type"],
              },
            },
          },
          required: ["title", "blocks"],
        },
        async execute(_toolCallId, params) {
          const {
            title,
            subtitle,
            blocks: rawBlocks,
          } = params as {
            title: string;
            subtitle?: string;
            blocks: Record<string, unknown>[];
          };

          const blocks = normalizeBlocks(rawBlocks);
          const id = randomUUID().slice(0, 8);
          const now = new Date().toISOString();
          const page: Page = {
            id,
            title,
            subtitle,
            blocks,
            version: 1,
            createdAt: now,
            updatedAt: now,
          };

          await savePage(page);

          const baseUrl = getBaseUrl();
          const url = `${baseUrl}/pages/${id}`;
          return {
            content: [
              {
                type: "text" as const,
                text: `Page created: ${url}`,
              },
            ],
            details: { id, url, version: 1 },
          };
        },
      },
      { name: "page_create" },
    );

    api.registerTool(
      {
        name: "page_update",
        label: "Page Update",
        description:
          "Update an existing page. Can replace title/subtitle/blocks, append blocks, or update a block at a specific index.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Page ID to update" },
            title: { type: "string", description: "New title" },
            subtitle: { type: "string", description: "New subtitle" },
            blocks: {
              type: "array",
              description: "Replace all blocks with this array",
              items: {
                type: "object",
                properties: { type: { type: "string" } },
                required: ["type"],
              },
            },
            append: {
              type: "array",
              description: "Append these blocks to the end",
              items: {
                type: "object",
                properties: { type: { type: "string" } },
                required: ["type"],
              },
            },
            updateAt: {
              type: "object",
              description: "Update a single block at a specific index",
              properties: {
                index: { type: "number", description: "Block index (0-based)" },
                block: {
                  type: "object",
                  properties: { type: { type: "string" } },
                  required: ["type"],
                },
              },
              required: ["index", "block"],
            },
          },
          required: ["id"],
        },
        async execute(_toolCallId, params) {
          const {
            id,
            title,
            subtitle,
            blocks: rawBlocks,
            append: rawAppend,
            updateAt: rawUpdateAt,
          } = params as {
            id: string;
            title?: string;
            subtitle?: string;
            blocks?: Record<string, unknown>[];
            append?: Record<string, unknown>[];
            updateAt?: { index: number; block: Record<string, unknown> };
          };

          const page = await loadPage(id);
          if (!page) {
            return {
              content: [{ type: "text" as const, text: `Page not found: ${id}` }],
              details: { error: "not_found" },
            };
          }

          if (title !== undefined) page.title = title;
          if (subtitle !== undefined) page.subtitle = subtitle;
          if (rawBlocks !== undefined) page.blocks = normalizeBlocks(rawBlocks);
          if (rawAppend) page.blocks.push(...normalizeBlocks(rawAppend));
          if (rawUpdateAt) {
            const updateAt = { index: rawUpdateAt.index, block: normalizeBlock(rawUpdateAt.block) };
            if (updateAt.index >= 0 && updateAt.index < page.blocks.length) {
              page.blocks[updateAt.index] = updateAt.block;
            } else {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Invalid block index: ${updateAt.index} (page has ${page.blocks.length} blocks)`,
                  },
                ],
                details: { error: "invalid_index" },
              };
            }
          }

          page.version += 1;
          page.updatedAt = new Date().toISOString();

          await savePage(page);

          return {
            content: [
              {
                type: "text" as const,
                text: `Page updated: "${page.title}" (v${page.version}, ${page.blocks.length} blocks)`,
              },
            ],
            details: { id, version: page.version, blockCount: page.blocks.length },
          };
        },
      },
      { name: "page_update" },
    );

    api.registerTool(
      {
        name: "page_list",
        label: "Page List",
        description: "List all pages in the workspace.",
        parameters: {
          type: "object",
          properties: {},
        },
        async execute() {
          const dir = getPagesDir();
          let files: string[];
          try {
            files = await readdir(dir);
          } catch {
            return {
              content: [{ type: "text" as const, text: "No pages found." }],
              details: { pages: [] },
            };
          }

          const pages: { id: string; title: string; updatedAt: string }[] = [];
          for (const file of files) {
            if (!file.endsWith(".json")) continue;
            try {
              const raw = await readFile(join(dir, file), "utf-8");
              const page = JSON.parse(raw) as Page;
              pages.push({ id: page.id, title: page.title, updatedAt: page.updatedAt });
            } catch {
              // skip corrupt files
            }
          }

          if (pages.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No pages found." }],
              details: { pages: [] },
            };
          }

          const text = pages.map((p) => `- ${p.title} (${p.id})`).join("\n");
          return {
            content: [{ type: "text" as const, text: `${pages.length} pages:\n${text}` }],
            details: { pages },
          };
        },
      },
      { name: "page_list" },
    );

    api.registerTool(
      {
        name: "page_delete",
        label: "Page Delete",
        description:
          "Delete a page by ID. Use when the user asks to remove a page, or when replacing an old page with a new one.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Page ID to delete" },
          },
          required: ["id"],
        },
        async execute(_toolCallId, params) {
          const { id } = params as { id: string };
          const dir = getPagesDir();
          const filePath = join(dir, `${id}.json`);
          try {
            const raw = await readFile(filePath, "utf-8");
            const page = JSON.parse(raw) as Page;
            await unlink(filePath);
            return {
              content: [{ type: "text" as const, text: `Deleted page: "${page.title}" (${id})` }],
              details: { id, title: page.title },
            };
          } catch {
            return {
              content: [{ type: "text" as const, text: `Page not found: ${id}` }],
              details: { error: "not_found" },
            };
          }
        },
      },
      { name: "page_delete" },
    );

    // ========================================================================
    // HTTP Routes
    // ========================================================================

    // Use registerHttpHandler for dynamic /pages/:id matching
    api.registerHttpHandler(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      // Match GET /pages/:id
      const pageMatch = pathname.match(/^\/pages\/([0-9a-f]{8})$/);
      if (pageMatch && req.method === "GET") {
        const id = pageMatch[1];
        const page = await loadPage(id);
        if (!page) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Page not found");
          return true;
        }

        const html = renderPage(page);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
        return true;
      }

      // Match GET /pages/:id/version
      const versionMatch = pathname.match(/^\/pages\/([0-9a-f]{8})\/version$/);
      if (versionMatch && req.method === "GET") {
        const id = versionMatch[1];
        const page = await loadPage(id);
        if (!page) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "not_found" }));
          return true;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: page.id, version: page.version, updatedAt: page.updatedAt }));
        return true;
      }

      return false;
    });

    // ========================================================================
    // Service (captures workspaceDir at startup)
    // ========================================================================

    api.registerService({
      id: "page-builder",
      async start(ctx) {
        if (ctx.workspaceDir) {
          resolvedWorkspaceDir = ctx.workspaceDir;
          ctx.logger.info(`page-builder: workspace → ${resolvedWorkspaceDir}`);
        } else {
          ctx.logger.warn("page-builder: no workspaceDir from service context, using fallback");
        }
        await ensurePagesDir();
        ctx.logger.info("page-builder: ready");
      },
    });
  },
};
