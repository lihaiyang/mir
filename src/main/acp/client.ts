/**
 * Client 实现：agent → client 的请求都从这里进来。
 *
 * 必选方法（requestPermission / sessionUpdate）转发给 sessionManager 注入的钩子；
 * 可选方法（fs / terminal）直接委派给 handlers。
 */
import type {
  Agent,
  Client,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse
} from '@agentclientprotocol/sdk'
import { readTextFile, writeTextFile } from './handlers/fs'
import { requestPermission as handlePermissionRequest } from './handlers/permission'
import {
  createTerminal,
  killTerminal,
  releaseTerminal,
  terminalOutput,
  waitForTerminalExit
} from './handlers/terminal'

export interface AcpClientOptions {
  agentId: string
  onSessionUpdate: (notification: SessionNotification) => void
  requestPermission: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>
}

export class AcpClient implements Client {
  private readonly agentId: string
  private readonly onSessionUpdate: (notification: SessionNotification) => void
  private readonly permissionHandler: (
    params: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>
  private agent: Agent | null = null

  constructor(options: AcpClientOptions) {
    this.agentId = options.agentId
    this.onSessionUpdate = options.onSessionUpdate
    this.permissionHandler = options.requestPermission
  }

  /** ClientSideConnection 构造回调里注入，供后续需要主动调用 agent 的场景使用 */
  setAgent(agent: Agent): void {
    this.agent = agent
  }

  getAgent(): Agent | null {
    return this.agent
  }

  async requestPermission(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    return this.permissionHandler(params)
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.onSessionUpdate(params)
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return readTextFile(params)
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return writeTextFile(params)
  }

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    return createTerminal(params)
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    return terminalOutput(params)
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest
  ): Promise<WaitForTerminalExitResponse> {
    return waitForTerminalExit(params)
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    return killTerminal(params)
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    return releaseTerminal(params)
  }
}
