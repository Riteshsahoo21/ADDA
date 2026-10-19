// Deprecated: Motion replication now operates via direct zero-delay Roblox-style snapshot broadcasting.
export class RoomMotionHub {
  allocateId(): number { return 0; }
  join(): void {}
  leave(): void {}
  receive(): boolean { return false; }
  receiveLegacy(): boolean { return false; }
  flush(): void {}
}
