import { packetIndices, robustSolitonCDF } from "./soliton";

/** Splits a file into k fixed-size blocks and emits XOR-coded packets. */
export class LTEncoder {
  readonly k: number;
  readonly blockSize: number;
  readonly fileSize: number;
  private readonly blocks: Uint8Array[];
  private readonly cdf: Float64Array;

  constructor(data: Uint8Array, blockSize: number, cdf?: Float64Array) {
    this.fileSize = data.length;
    this.blockSize = blockSize;
    this.k = Math.max(1, Math.ceil(data.length / blockSize));
    this.blocks = [];
    for (let i = 0; i < this.k; i++) {
      const block = new Uint8Array(blockSize);
      block.set(data.subarray(i * blockSize, (i + 1) * blockSize));
      this.blocks.push(block);
    }
    this.cdf = cdf ?? robustSolitonCDF(this.k);
  }

  /** XOR of the source blocks selected by this seed. */
  encode(seed: number): Uint8Array {
    const indices = packetIndices(seed, this.k, this.cdf);
    const out = new Uint8Array(this.blockSize);
    for (const idx of indices) {
      const block = this.blocks[idx];
      for (let i = 0; i < this.blockSize; i++) out[i] ^= block[i];
    }
    return out;
  }
}

interface PendingPacket {
  indices: Set<number>;
  data: Uint8Array;
}

/** Peeling (belief-propagation) decoder for LT packets. */
export class LTDecoder {
  readonly k: number;
  readonly blockSize: number;
  readonly fileSize: number;
  solvedCount = 0;
  packetsUsed = 0;
  duplicates = 0;
  private readonly blocks: (Uint8Array | null)[];
  private readonly cdf: Float64Array;
  private pending: PendingPacket[] = [];
  private readonly seenSeeds = new Set<number>();

  constructor(k: number, blockSize: number, fileSize: number, cdf?: Float64Array) {
    this.k = k;
    this.blockSize = blockSize;
    this.fileSize = fileSize;
    this.blocks = new Array(k).fill(null);
    this.cdf = cdf ?? robustSolitonCDF(k);
  }

  get done(): boolean {
    return this.solvedCount === this.k;
  }

  /** Returns true if the packet was new (not a duplicate seed). */
  addPacket(seed: number, payload: Uint8Array): boolean {
    if (this.seenSeeds.has(seed)) {
      this.duplicates++;
      return false;
    }
    this.seenSeeds.add(seed);
    if (this.done) return false;
    this.packetsUsed++;

    const indices = new Set(packetIndices(seed, this.k, this.cdf));
    const data = payload.slice(0, this.blockSize);

    // Subtract already-solved blocks.
    for (const idx of [...indices]) {
      const solved = this.blocks[idx];
      if (solved) {
        for (let i = 0; i < this.blockSize; i++) data[i] ^= solved[i];
        indices.delete(idx);
      }
    }
    if (indices.size === 0) return true; // redundant packet
    if (indices.size === 1) {
      this.solve(indices.values().next().value!, data);
    } else {
      this.pending.push({ indices, data });
    }
    return true;
  }

  private solve(index: number, data: Uint8Array): void {
    // Iterative peeling: solving one block may reduce stored packets to
    // degree 1, which solves further blocks.
    const queue: Array<[number, Uint8Array]> = [[index, data]];
    while (queue.length > 0) {
      const [idx, blockData] = queue.pop()!;
      if (this.blocks[idx]) continue;
      this.blocks[idx] = blockData;
      this.solvedCount++;

      const stillPending: PendingPacket[] = [];
      for (const pkt of this.pending) {
        if (pkt.indices.has(idx)) {
          for (let i = 0; i < this.blockSize; i++) pkt.data[i] ^= blockData[i];
          pkt.indices.delete(idx);
        }
        if (pkt.indices.size === 1) {
          queue.push([pkt.indices.values().next().value!, pkt.data]);
        } else if (pkt.indices.size > 1) {
          stillPending.push(pkt);
        }
      }
      this.pending = stillPending;
    }
  }

  /** Reassembled file; only valid once done. */
  assemble(): Uint8Array {
    if (!this.done) throw new Error("decode incomplete");
    const out = new Uint8Array(this.fileSize);
    for (let i = 0; i < this.k; i++) {
      const block = this.blocks[i]!;
      const offset = i * this.blockSize;
      out.set(block.subarray(0, Math.min(this.blockSize, this.fileSize - offset)), offset);
    }
    return out;
  }
}
