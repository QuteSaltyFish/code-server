import { field, logger } from "@coder/logger"
import * as cp from "child_process"
import * as crypto from "crypto"
import * as http from "http"
import * as net from "net"
import * as path from "path"
import {
  CodeServerMessage,
  Settings,
  VscodeMessage,
  VscodeOptions,
  WorkbenchOptions,
} from "../../../lib/vscode/src/vs/server/ipc"
import { generateUuid } from "../../common/util"
import { HttpProvider, HttpProviderOptions, HttpResponse, Route } from "../http"
import { SettingsProvider } from "../settings"
import { xdgLocalDir } from "../util"

export class VscodeHttpProvider extends HttpProvider {
  private readonly serverRootPath: string
  private readonly vsRootPath: string
  private readonly settings = new SettingsProvider<Settings>(path.join(xdgLocalDir, "coder.json"))
  private _vscode?: Promise<cp.ChildProcess>
  private workbenchOptions?: WorkbenchOptions

  public constructor(options: HttpProviderOptions, private readonly args: string[]) {
    super(options)
    this.vsRootPath = path.resolve(this.rootPath, "lib/vscode")
    this.serverRootPath = path.join(this.vsRootPath, "out/vs/server")
  }

  private async initialize(options: VscodeOptions): Promise<WorkbenchOptions> {
    const id = generateUuid()
    const vscode = await this.fork()

    logger.debug("Setting up VS Code...")
    return new Promise<WorkbenchOptions>((resolve, reject) => {
      vscode.once("message", (message: VscodeMessage) => {
        logger.debug("Got message from VS Code", field("message", message))
        return message.type === "options" && message.id === id
          ? resolve(message.options)
          : reject(new Error("Unexpected response during initialization"))
      })
      vscode.once("error", reject)
      vscode.once("exit", (code) => reject(new Error(`VS Code exited unexpectedly with code ${code}`)))
      this.send({ type: "init", id, options }, vscode)
    })
  }

  private fork(): Promise<cp.ChildProcess> {
    if (!this._vscode) {
      logger.debug("Forking VS Code...")
      const vscode = cp.fork(path.join(this.serverRootPath, "fork"))
      vscode.on("error", (error) => {
        logger.error(error.message)
        this._vscode = undefined
      })
      vscode.on("exit", (code) => {
        logger.error(`VS Code exited unexpectedly with code ${code}`)
        this._vscode = undefined
      })

      this._vscode = new Promise((resolve, reject) => {
        vscode.once("message", (message: VscodeMessage) => {
          logger.debug("Got message from VS Code", field("message", message))
          return message.type === "ready"
            ? resolve(vscode)
            : reject(new Error("Unexpected response waiting for ready response"))
        })
        vscode.once("error", reject)
        vscode.once("exit", (code) => reject(new Error(`VS Code exited unexpectedly with code ${code}`)))
      })
    }

    return this._vscode
  }

  public async handleWebSocket(route: Route, request: http.IncomingMessage, socket: net.Socket): Promise<true> {
    if (!this.authenticated(request)) {
      throw new Error("not authenticated")
    }

    // VS Code expects a raw socket. It will handle all the web socket frames.
    // We just need to handle the initial upgrade.
    // This magic value is specified by the websocket spec.
    const magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    const reply = crypto
      .createHash("sha1")
      .update(request.headers["sec-websocket-key"] + magic)
      .digest("base64")
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${reply}`,
      ].join("\r\n") + "\r\n\r\n"
    )

    const vscode = await this._vscode
    this.send({ type: "socket", query: route.query }, vscode, socket)
    return true
  }

  private send(message: CodeServerMessage, vscode?: cp.ChildProcess, socket?: net.Socket): void {
    if (!vscode || vscode.killed) {
      throw new Error("vscode is not running")
    }
    vscode.send(message, socket)
  }

  public async handleRequest(route: Route, request: http.IncomingMessage): Promise<HttpResponse | undefined> {
    this.ensureGet(request)
    this.ensureAuthenticated(request)
    switch (route.base) {
      case "/":
        try {
          return await this.getRoot(request, route)
        } catch (error) {
          return this.getErrorRoot(error)
        }
      case "/static": {
        switch (route.requestPath) {
          case "/out/vs/workbench/services/extensions/worker/extensionHostWorkerMain.js": {
            const response = await this.getUtf8Resource(this.vsRootPath, route.requestPath)
            response.content = response.content.replace(
              /{{COMMIT}}/g,
              this.workbenchOptions ? this.workbenchOptions.commit : ""
            )
            response.cache = true
            return response
          }
        }
        const response = await this.getResource(this.vsRootPath, route.requestPath)
        response.cache = true
        return response
      }
      case "/resource":
      case "/vscode-remote-resource":
        if (typeof route.query.path === "string") {
          return this.getResource(route.query.path)
        }
        break
      case "/tar":
        if (typeof route.query.path === "string") {
          return this.getTarredResource(route.query.path)
        }
        break
      case "/webview":
        if (/^\/vscode-resource/.test(route.requestPath)) {
          return this.getResource(route.requestPath.replace(/^\/vscode-resource(\/file)?/, ""))
        }
        return this.getResource(this.vsRootPath, "out/vs/workbench/contrib/webview/browser/pre", route.requestPath)
    }
    return undefined
  }

  private async getRoot(request: http.IncomingMessage, route: Route): Promise<HttpResponse> {
    const settings = await this.settings.read()
    const [response, options] = await Promise.all([
      await this.getUtf8Resource(this.rootPath, `src/node/vscode/workbench${!this.isDev ? "-build" : ""}.html`),
      this.initialize({
        args: this.args,
        query: route.query,
        remoteAuthority: request.headers.host as string,
        settings,
      }),
    ])

    this.workbenchOptions = options

    if (options.startPath) {
      this.settings.write({
        lastVisited: {
          path: options.startPath.path,
          workspace: options.startPath.workspace,
        },
      })
    }

    return {
      ...response,
      content: response.content
        .replace(/{{COMMIT}}/g, options.commit)
        .replace(`"{{REMOTE_USER_DATA_URI}}"`, `'${JSON.stringify(options.remoteUserDataUri)}'`)
        .replace(`"{{PRODUCT_CONFIGURATION}}"`, `'${JSON.stringify(options.productConfiguration)}'`)
        .replace(`"{{WORKBENCH_WEB_CONFIGURATION}}"`, `'${JSON.stringify(options.workbenchWebConfiguration)}'`)
        .replace(`"{{NLS_CONFIGURATION}}"`, `'${JSON.stringify(options.nlsConfiguration)}'`),
    }
  }

  private async getErrorRoot(error: Error): Promise<HttpResponse> {
    const response = await this.getUtf8Resource(this.rootPath, "src/node/vscode/error.html")
    const message = `VS Code failed to load. ${
      this.isDev ? "It might not have finished compiling (check for 'Finished compilation' in the output)." : ""
    } <br><br>${error}`
    response.content = response.content.replace(/{{COMMIT}}/g, this.options.commit).replace(/{{ERROR}}/g, message)
    return response
  }
}