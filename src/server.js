import { createServer } from "node:http";
import { fileURLToPath, URL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListResourceTemplatesRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import path from "node:path";
import { readFileSync } from "node:fs";
function widgetMeta(widget) {
    return {
        "openai/outputTemplate": widget.templateUri,
        "openai/toolInvocation/invoking": widget.invoking,
        "openai/toolInvocation/invoked": widget.invoked,
        "openai/widgetAccessible": true,
        "openai/resultCanProduceWidget": true
    };
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const widgetHtmlPath = path.resolve(__dirname, "../story/demo.html");
const demoHtml = readFileSync(widgetHtmlPath, "utf8");
const widgets = {
    id: "zk-demo",
    title: "uesZkDemo",
    templateUri: "ui://widget/zk.html",
    invoking: "zk invoking",
    invoked: "zk invoked",
    html: demoHtml,
    responseText: "help!"
};
const toolInputSchema = {
    type: "object",
    properties: {
        pizzaTopping: {
            type: "string",
            description: "Topping to mention when rendering the widget."
        }
    },
    required: ["pizzaTopping"],
    additionalProperties: false
};
const toolInputParser = z.object({
    pizzaTopping: z.string()
});
const tools = [
    {
        name: widgets.id,
        description: widgets.title,
        inputSchema: toolInputSchema,
        title: widgets.title,
        _meta: widgetMeta(widgets)
    }
];
const resources = [{
        uri: widgets.templateUri,
        name: widgets.title,
        description: `demo -- resources`,
        mimeType: "text/html+skybridge",
        _meta: widgetMeta(widgets)
    }];
const resourceTemplates = [{
        uriTemplate: widgets.templateUri,
        name: widgets.title,
        description: `demo -- resources template`,
        mimeType: "text/html+skybridge",
        _meta: widgetMeta(widgets)
    }];
function createPizzazServer() {
    const server = new Server({
        name: "zk-demo-node",
        version: "0.1.0"
    }, {
        capabilities: {
            resources: {},
            tools: {}
        }
    });
    server.setRequestHandler(ListResourcesRequestSchema, async (_request) => ({
        resources
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        return {
            contents: [
                {
                    uri: widgets.templateUri,
                    mimeType: "text/html+skybridge",
                    text: widgets.html,
                    _meta: widgetMeta(widgets)
                }
            ]
        };
    });
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (_request) => ({
        resourceTemplates
    }));
    server.setRequestHandler(ListToolsRequestSchema, async (_request) => ({
        tools
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const args = toolInputParser.parse(request.params.arguments ?? {});
        return {
            content: [
                {
                    type: "text",
                    text: widgets.responseText
                }
            ],
            structuredContent: {
                pizzaTopping: args.pizzaTopping
            },
            _meta: widgetMeta(widgets)
        };
    });
    return server;
}
const sessions = new Map();
const ssePath = "/mcp";
const postPath = "/mcp/messages";
async function handleSseRequest(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const server = createPizzazServer();
    const transport = new SSEServerTransport(postPath, res);
    const sessionId = transport.sessionId;
    sessions.set(sessionId, { server, transport });
    transport.onclose = async () => {
        sessions.delete(sessionId);
        await server.close();
    };
    transport.onerror = (error) => {
        console.error("SSE transport error", error);
    };
    try {
        await server.connect(transport);
    }
    catch (error) {
        sessions.delete(sessionId);
        console.error("Failed to start SSE session", error);
        if (!res.headersSent) {
            res.writeHead(500).end("Failed to establish SSE connection");
        }
    }
}
async function handlePostMessage(req, res, url) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
        res.writeHead(400).end("Missing sessionId query parameter");
        return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
        res.writeHead(404).end("Unknown session");
        return;
    }
    try {
        await session.transport.handlePostMessage(req, res);
    }
    catch (error) {
        console.error("Failed to process message", error);
        if (!res.headersSent) {
            res.writeHead(500).end("Failed to process message");
        }
    }
}
const portEnv = Number(process.env.PORT ?? 8000);
const port = Number.isFinite(portEnv) ? portEnv : 8000;
const httpServer = createServer(async (req, res) => {
    if (!req.url) {
        res.writeHead(400).end("Missing URL");
        return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "OPTIONS" && (url.pathname === ssePath || url.pathname === postPath)) {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "content-type"
        });
        res.end();
        return;
    }
    if (req.method === "GET" && url.pathname === ssePath) {
        await handleSseRequest(res);
        return;
    }
    if (req.method === "POST" && url.pathname === postPath) {
        await handlePostMessage(req, res, url);
        return;
    }
    res.writeHead(404).end("Not Found");
});
httpServer.on("clientError", (err, socket) => {
    console.error("HTTP client error", err);
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});
httpServer.listen(port, () => {
    console.log(`Pizzaz MCP server listening on http://localhost:${port}`);
    console.log(`  SSE stream: GET http://localhost:${port}${ssePath}`);
    console.log(`  Message post endpoint: POST http://localhost:${port}${postPath}?sessionId=...`);
});
