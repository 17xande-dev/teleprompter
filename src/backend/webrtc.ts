const POLL_TIMEOUT_MS = 30_000;
// ── Types ──────────────────────────

export type Role = "offerer" | "answerer";

// ICE (Interactive Connectivity Establishment) is a WebRTC framework for connecting 2 peers, regardless
// of network topology.
// The protocol looks for the lowest latency path for connecting 2 peers, trying these options in order:
// 1. Direct UDP connection (Uses a STUN server to find network-facing address of a peer)
// 2. Direct TCP connection via HTTP port
// 3. Direct TCP connection via HTTPS port
// 4. Indirect connection via relay/TURN server (if peer behind firewall block NAT traversal)
interface IceCandidateInit {
  candidate?: string;
  sdpMid?: string;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface CandidateItem {
  candidate?: IceCandidateInit;
  done?: boolean;
}

// RoleState encapsulates the long-poll mechanics for one role's SDP and candidate stream.
// Each instance holds state for one side if the handshake and knows how to
// block callers until data arrives or the timeout expires.
export class RoleState {
  private sdp: string | null = null;
  private sdpWaiters: Array<(sdp: string) => void> = [];

  // Candidates are produced by this role and consumed by the other.
  private candidateQueue: CandidateItem[] = [];
  private candidateWaiter: ((item: CandidateItem) => void) | null = null;

  // publishSdp sends the sdp to all sdpWaiters.
  publishSdp(sdp: string): void {
    this.sdp = sdp;
    this.sdpWaiters.splice(0).forEach((fn) => fn(sdp));
  }

  waitForSdp(): Promise<string | null> {
    if (this.sdp !== null) return Promise.resolve(this.sdp);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.sdpWaiters = this.sdpWaiters.filter((fn) => fn !== notify);
        resolve(null);
      }, POLL_TIMEOUT_MS);

      const notify = (sdp: string) => {
        clearTimeout(timer);
        resolve(sdp);
      };
      this.sdpWaiters.push(notify);
    });
  }

  pushCandidate(item: CandidateItem): void {
    if (this.candidateWaiter) {
      const fn = this.candidateWaiter;
      this.candidateWaiter = null;
      fn(item);
    } else {
      this.candidateQueue.push(item);
    }
  }

  // waitForCandidate resolves with the next queued item immediately, or parks until one
  // arrives or the timeout fires (returns null).
  waitForCandidate(): Promise<CandidateItem | null> {
    if (this.candidateQueue.length > 0) {
      return Promise.resolve(this.candidateQueue.shift()!);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.candidateWaiter = null;
        resolve(null);
      }, POLL_TIMEOUT_MS);

      this.candidateWaiter = (item) => {
        clearTimeout(timer);
        resolve(item);
      };
    });
  }

  reset(): void {
    this.sdp = null;
    this.sdpWaiters = [];
    this.candidateQueue = [];
    this.candidateWaiter = null;
  }
}
