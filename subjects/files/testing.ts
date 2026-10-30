// An agent directory for tests: bindings and addresses in memory, with no
// registry behind it

import { addressAlive } from "../../platform/session.ts"
import type { Address, AgentId, Route } from "../../core/model.ts"
import type { AgentDirectory } from "./files.ts"

export class MemoryDirectory implements AgentDirectory {
  addresses = new Map<AgentId, Address>()
  bindings = new Map<string, AgentId>()
  held = new Set<string>()
  standIn: Address | null = null

  agentId = (ref: { block: string | null; session: string | null }) =>
    ref.block ?? ref.session
  bind(agent: AgentId, address: Address | null) {
    if (address) this.addresses.set(agent, address)
  }
  bindFile(path: string, agent: AgentId) {
    this.bindings.set(path, agent)
  }
  binding(path: string) {
    return this.bindings.get(path) ?? null
  }
  route(path: string, target: AgentId | null = null): Route | null {
    const agent = target ?? this.binding(path)
    const own = agent && this.addresses.get(agent)
    if (own && addressAlive(own)) return { address: own, via: "agent" }
    if (agent && this.standIn) return { address: this.standIn, via: "tab" }
    return own ? { address: own, via: "agent" } : null
  }
  hold(path: string, held: boolean) {
    if (held) this.held.add(path)
    else this.held.delete(path)
  }
}
