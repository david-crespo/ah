// An agent directory for tests: bindings and addresses in memory, with no
// registry behind it

import { addressAlive } from "../../platform/session.ts"
import type { Address, AgentId } from "../../core/model.ts"
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
  route(path: string, target: AgentId | null = null): Address | null {
    const agent = target ?? this.binding(path)
    if (!agent) return null
    const own = this.addresses.get(agent) ?? null
    return addressAlive(own) ? own : (this.standIn ?? own)
  }
  hold(path: string, held: boolean) {
    if (held) this.held.add(path)
    else this.held.delete(path)
  }
}
