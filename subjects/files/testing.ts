// An agent directory for tests: bindings and addresses in memory, with no
// registry behind it

import { addressAlive } from "../../platform/session.ts"
import {
  type Address,
  type AgentId,
  type Requestable,
  type Route,
  type SubjectKey,
  subjectKey,
} from "../../core/model.ts"
import type { AgentDirectory } from "./files.ts"

export class MemoryDirectory implements AgentDirectory {
  addresses = new Map<AgentId, Address>()
  bindings = new Map<SubjectKey, AgentId>()
  held = new Set<SubjectKey>()
  standIn: Address | null = null

  agentId = (ref: { block: string | null; session: string | null }) =>
    ref.block ?? ref.session
  bind(agent: AgentId, address: Address | null) {
    if (address) this.addresses.set(agent, address)
  }
  bindSubject(subject: Requestable, agent: AgentId) {
    this.bindings.set(subjectKey(subject), agent)
  }
  binding(subject: Requestable) {
    return this.bindings.get(subjectKey(subject)) ?? null
  }
  route(subject: Requestable, target: AgentId | null = null): Route | null {
    const agent = target ?? this.binding(subject)
    const own = agent && this.addresses.get(agent)
    if (own && addressAlive(own)) return { address: own, via: "agent" }
    if (agent && this.standIn) return { address: this.standIn, via: "tab" }
    return own ? { address: own, via: "agent" } : null
  }
  hold(subject: Requestable, held: boolean) {
    if (held) this.held.add(subjectKey(subject))
    else this.held.delete(subjectKey(subject))
  }
}
