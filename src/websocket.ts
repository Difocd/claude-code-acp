import { spawn, ChildProcess } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ProxyOptions {
  port?: number;
  host?: string;
  debug?: boolean;
}

export class WebSocketProxy {
  private wss: WebSocketServer;
  private agent: ChildProcess;
  private currentClient: WebSocket | null = null;
  private debug: boolean;

  constructor(options: ProxyOptions = {}) {
    const { port = 8765, host = "localhost", debug = false } = options;
    this.debug = debug || process.env.ACP_DEBUG === "true";

    this.log(`Starting WebSocket proxy server on ${host}:${port}`);

    // Start the ACP agent as a subprocess
    const agentPath = join(__dirname, "index.js");
    this.agent = spawn("node", [agentPath], {
      stdio: ["pipe", "pipe", "inherit"], // stdin, stdout, stderr
      env: {
        ...process.env,
        ACP_DEBUG: this.debug ? "true" : "false",
      },
    });

    // Setup WebSocket server
    this.wss = new WebSocketServer({ port, host });
    this.setupWebSocketServer();
    this.setupAgentListeners();

    this.log(`WebSocket proxy server is running on ws://${host}:${port}`);
  }

  private log(message: string): void {
    console.error(`[WebSocket Proxy] ${message}`);
  }

  private setupWebSocketServer(): void {
    this.wss.on("connection", (ws: WebSocket) => {
      this.log("Client connected");

      // Close any existing client connection
      if (this.currentClient) {
        this.log("Closing existing client connection");
        this.currentClient.close();
      }

      this.currentClient = ws;

      ws.on("message", (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.log(`Client → Agent: ${JSON.stringify(message)}`);
        } catch {
          this.log(`Client → Agent: ${data.toString()}`);
        }

        // Forward WebSocket message to agent stdin
        if (this.agent.stdin && this.agent.stdin.writable) {
          this.agent.stdin.write(data);
        } else {
          this.log("Warning: Agent stdin is not writable");
        }
      });

      ws.on("close", () => {
        this.log("Client disconnected");
        if (this.currentClient === ws) {
          this.currentClient = null;
        }
      });

      ws.on("error", (error: Error) => {
        console.error("[WebSocket Proxy] Client error:", error);
      });

      // Send a ping every 30 seconds to keep connection alive
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        } else {
          clearInterval(pingInterval);
        }
      }, 30000);

      ws.on("pong", () => {
        this.log("Received pong from client");
      });
    });

    this.wss.on("error", (error) => {
      console.error("[WebSocket Proxy] Server error:", error);
    });
  }

  private setupAgentListeners(): void {
    // Forward agent stdout to current WebSocket client
    if (this.agent.stdout) {
      this.agent.stdout.on("data", (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.log(`Agent → Client: ${JSON.stringify(message)}`);
        } catch {
          this.log(`Agent → Client: ${data.toString()}`);
        }

        // Send to current client if connected
        if (this.currentClient && this.currentClient.readyState === WebSocket.OPEN) {
          this.currentClient.send(data);
        } else {
          this.log("No active client to forward message to");
        }
      });
    }

    // Handle agent exit
    this.agent.on("exit", (code) => {
      console.error(`[WebSocket Proxy] ACP agent exited with code ${code}`);
      this.shutdown(code || 0);
    });

    this.agent.on("error", (error: Error) => {
      console.error("[WebSocket Proxy] Agent error:", error);
      this.shutdown(1);
    });
  }

  public shutdown(exitCode: number = 0): void {
    this.log("Shutting down WebSocket proxy server");

    // Close all WebSocket connections
    this.wss.clients.forEach((client: WebSocket) => {
      client.close();
    });

    // Close the WebSocket server
    this.wss.close(() => {
      this.log("WebSocket server closed");
    });

    // Kill the agent process if still running
    if (!this.agent.killed) {
      this.agent.kill();
    }

    process.exit(exitCode);
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.WS_PORT || "8765");
  const host = process.env.WS_HOST || "localhost";

  const proxy = new WebSocketProxy({ port, host });

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nReceived SIGINT, shutting down gracefully...");
    proxy.shutdown(0);
  });

  process.on("SIGTERM", () => {
    console.log("\nReceived SIGTERM, shutting down gracefully...");
    proxy.shutdown(0);
  });
}