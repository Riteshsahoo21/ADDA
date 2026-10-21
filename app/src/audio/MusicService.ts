import { createVideoPlayer, type VideoPlayer } from 'expo-video';
import { Directory, File, Paths } from 'expo-file-system';
import { API_BASE_URL } from '../lib/auth-client';
import playlistTracks from '../../assets/playlist_tracks.json';

export type MusicTrack = {
  id: string;
  title: string;
  rawTitle?: string;
  sizeBytes?: number;
};

export type MusicState = {
  // Headphone (Client 2D)
  clientTrackIndex: number;
  clientIsPlaying: boolean;
  clientVolume: number; // 0 to 1
  clientMuted: boolean;

  // In-World 3D Radio
  radioTrackIndex: number;
  radioEnabled: boolean; // ON / OFF
  radioVolume: number; // User master radio volume (0 to 1)
  radioMuted: boolean;
  radio3DAttenuation: number; // Computed in 3D loop by distance (0 to 1)
};

export const PLAYLIST_TRACKS: MusicTrack[] = playlistTracks;

type Listener = (state: MusicState) => void;

class MusicServiceManager {
  private clientPlayer: VideoPlayer | null = null;
  private radioPlayer: VideoPlayer | null = null;
  private currentClientUrl: string | null = null;
  private currentRadioUrl: string | null = null;
  private lastAppliedRadioVolume = -1;
  private lastAttenuationUpdate = 0;
  private preloadingIds = new Set<string>();
  private listeners = new Set<Listener>();

  public state: MusicState = {
    clientTrackIndex: 0,
    clientIsPlaying: false,
    clientVolume: 0.75,
    clientMuted: false,

    radioTrackIndex: 0,
    radioEnabled: false,
    radioVolume: 0.85,
    radioMuted: false,
    radio3DAttenuation: 0.7,
  };

  private getCacheFile(id: string): File {
    const dir = new Directory(Paths.document, 'adda-music-cache');
    dir.create({ idempotent: true, intermediates: true });
    return new File(dir, `${id}.m4a`);
  }

  private getTrackUri(id: string): string {
    try {
      const file = this.getCacheFile(id);
      if (file.exists && file.size > 20000) {
        return file.uri;
      }
      // Trigger background download to local cache so future plays are 100% offline & stutter-free
      void this.preloadTrack(id);
    } catch {}
    return `${API_BASE_URL}/music/${id}.m4a`;
  }

  private async preloadTrack(id: string) {
    if (this.preloadingIds.has(id)) return;
    this.preloadingIds.add(id);
    try {
      const file = this.getCacheFile(id);
      if (file.exists && file.size > 20000) return;
      const remoteUrl = `${API_BASE_URL}/music/${id}.m4a`;
      await File.downloadFileAsync(remoteUrl, file);
      console.log('[ADDA Music] Cached track locally:', id, file.size);
    } catch (e) {
      console.warn('[ADDA Music] Background cache failed for track:', id, e);
    } finally {
      this.preloadingIds.delete(id);
    }
  }

  public init() {
    // Only verify state is initialized; players are created lazily on-demand
  }

  private ensureClientPlayer(): VideoPlayer | null {
    if (this.clientPlayer) return this.clientPlayer;
    if (PLAYLIST_TRACKS.length === 0) return null;

    try {
      const trackId = PLAYLIST_TRACKS[this.state.clientTrackIndex].id;
      const uri = this.getTrackUri(trackId);
      this.currentClientUrl = uri;
      console.log('[ADDA Music] Creating lazy client player:', uri);
      const player = createVideoPlayer(uri);
      player.audioMixingMode = 'mixWithOthers';
      player.loop = true;
      player.volume = this.state.clientMuted ? 0 : this.state.clientVolume;
      player.addListener('statusChange', (payload: any) => {
        console.log('[ADDA Music] Client player status:', payload?.status, payload?.error?.message ?? '');
      });
      this.clientPlayer = player;
      return player;
    } catch (e) {
      console.warn('[ADDA Music] Failed to create client player', e);
      return null;
    }
  }

  private ensureRadioPlayer(): VideoPlayer | null {
    if (this.radioPlayer) return this.radioPlayer;
    if (PLAYLIST_TRACKS.length === 0) return null;

    try {
      const trackId = PLAYLIST_TRACKS[this.state.radioTrackIndex].id;
      const uri = this.getTrackUri(trackId);
      this.currentRadioUrl = uri;
      console.log('[ADDA Music] Creating lazy radio player:', uri);
      const player = createVideoPlayer(uri);
      player.audioMixingMode = 'mixWithOthers';
      player.loop = true;
      player.addListener('statusChange', (payload: any) => {
        console.log('[ADDA Music] Radio player status:', payload?.status, payload?.error?.message ?? '');
      });
      this.radioPlayer = player;
      this.updateEffectiveRadioVolume();
      return player;
    } catch (e) {
      console.warn('[ADDA Music] Failed to create radio player', e);
      return null;
    }
  }

  public stopAll() {
    console.log('[ADDA Music] Stopping all audio players and releasing media sessions');
    if (this.radioPlayer) {
      try {
        this.radioPlayer.pause();
        this.radioPlayer.volume = 0;
        if (typeof (this.radioPlayer as any).release === 'function') {
          (this.radioPlayer as any).release();
        }
      } catch {}
      this.radioPlayer = null;
    }
    if (this.clientPlayer) {
      try {
        this.clientPlayer.pause();
        this.clientPlayer.volume = 0;
        if (typeof (this.clientPlayer as any).release === 'function') {
          (this.clientPlayer as any).release();
        }
      } catch {}
      this.clientPlayer = null;
    }
    this.state.clientIsPlaying = false;
    this.state.radioEnabled = false;
    this.currentClientUrl = null;
    this.currentRadioUrl = null;
    this.lastAppliedRadioVolume = 0;
    this.notify();
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach(fn => fn({ ...this.state }));
  }

  // --- Headphone (Client-Side) Controls ---

  public toggleClientPlay() {
    const player = this.ensureClientPlayer();
    if (!player) return;

    if (this.state.clientIsPlaying) {
      player.pause();
      this.state.clientIsPlaying = false;
    } else {
      player.play();
      this.state.clientIsPlaying = true;
    }
    this.notify();
  }

  public playClientTrack(index: number) {
    if (index < 0 || index >= PLAYLIST_TRACKS.length) return;
    const trackChanged = this.state.clientTrackIndex !== index;
    this.state.clientTrackIndex = index;
    const player = this.ensureClientPlayer();
    if (player) {
      const uri = this.getTrackUri(PLAYLIST_TRACKS[index].id);
      if (trackChanged || this.currentClientUrl !== uri) {
        this.currentClientUrl = uri;
        console.log('[ADDA Music] Replacing client track:', index, uri);
        player.replace(uri);
      }
      player.volume = this.state.clientMuted ? 0 : this.state.clientVolume;
      player.play();
      this.state.clientIsPlaying = true;
    }
    this.notify();
  }

  public nextClientTrack() {
    const next = (this.state.clientTrackIndex + 1) % PLAYLIST_TRACKS.length;
    this.playClientTrack(next);
  }

  public prevClientTrack() {
    const prev = (this.state.clientTrackIndex - 1 + PLAYLIST_TRACKS.length) % PLAYLIST_TRACKS.length;
    this.playClientTrack(prev);
  }

  public setClientVolume(vol: number) {
    this.state.clientVolume = Math.max(0, Math.min(1, vol));
    if (this.clientPlayer && !this.state.clientMuted) {
      this.clientPlayer.volume = this.state.clientVolume;
    }
    this.notify();
  }

  public toggleClientMute() {
    this.state.clientMuted = !this.state.clientMuted;
    if (this.clientPlayer) {
      this.clientPlayer.volume = this.state.clientMuted ? 0 : this.state.clientVolume;
    }
    this.notify();
  }

  // --- In-World 3D Radio Controls ---

  public setRadioEnabled(enabled: boolean, force = false) {
    if (this.state.radioEnabled === enabled && !force) return;
    this.state.radioEnabled = enabled;
    if (enabled) {
      const player = this.ensureRadioPlayer();
      if (player) {
        this.updateEffectiveRadioVolume();
        player.play();
      }
    } else if (this.radioPlayer) {
      this.radioPlayer.pause();
      this.lastAppliedRadioVolume = 0;
      this.radioPlayer.volume = 0;
    }
    this.notify();
  }

  public playRadioTrack(index: number, seekSeconds = 0) {
    if (index < 0 || index >= PLAYLIST_TRACKS.length) return;
    const trackChanged = this.state.radioTrackIndex !== index;
    this.state.radioTrackIndex = index;

    if (this.state.radioEnabled || this.radioPlayer) {
      const player = this.ensureRadioPlayer();
      if (player) {
        const uri = this.getTrackUri(PLAYLIST_TRACKS[index].id);
        if (trackChanged || this.currentRadioUrl !== uri) {
          this.currentRadioUrl = uri;
          console.log('[ADDA Music] Replacing radio track:', index, uri);
          player.replace(uri);
          if (seekSeconds > 0) {
            player.currentTime = seekSeconds;
          }
        }
        if (this.state.radioEnabled) {
          this.updateEffectiveRadioVolume();
          player.play();
        } else {
          player.pause();
          this.lastAppliedRadioVolume = 0;
          player.volume = 0;
        }
      }
    }
    this.notify();
  }

  public nextRadioTrack() {
    const next = (this.state.radioTrackIndex + 1) % PLAYLIST_TRACKS.length;
    this.playRadioTrack(next);
  }

  public prevRadioTrack() {
    const prev = (this.state.radioTrackIndex - 1 + PLAYLIST_TRACKS.length) % PLAYLIST_TRACKS.length;
    this.playRadioTrack(prev);
  }

  public setRadioVolume(vol: number) {
    this.state.radioVolume = Math.max(0, Math.min(1, vol));
    this.updateEffectiveRadioVolume();
    this.notify();
  }

  public toggleRadioMute() {
    this.state.radioMuted = !this.state.radioMuted;
    this.updateEffectiveRadioVolume();
    this.notify();
  }

  /**
   * Called from Three.js render loop to update distance-based volume.
   * Throttled to ~10Hz and ignores tiny movements to prevent ExoPlayer audio jitter!
   * @param attenuation 0.0 (too far) to 1.0 (right beside the radio)
   */
  public updateSpatialAttenuation(attenuation: number) {
    const now = Date.now();
    if (now - this.lastAttenuationUpdate < 90) return; // ~11 updates per second maximum
    this.lastAttenuationUpdate = now;

    const clamped = Math.max(0, Math.min(1, attenuation));
    // Skip if difference is negligible to save native bridge calls
    if (Math.abs(clamped - this.state.radio3DAttenuation) < 0.035) {
      return;
    }
    this.state.radio3DAttenuation = clamped;
    this.updateEffectiveRadioVolume();
  }

  private updateEffectiveRadioVolume() {
    if (!this.radioPlayer) return;
    const targetVolume = (!this.state.radioEnabled || this.state.radioMuted)
      ? 0
      : Math.max(0, Math.min(1, this.state.radioVolume * this.state.radio3DAttenuation));

    // Only update native volume if it changed by at least 3.5%
    if (Math.abs(targetVolume - this.lastAppliedRadioVolume) >= 0.035) {
      this.lastAppliedRadioVolume = targetVolume;
      this.radioPlayer.volume = targetVolume;
    }
  }

  public getCurrentRadioTrack(): MusicTrack {
    return PLAYLIST_TRACKS[this.state.radioTrackIndex] ?? PLAYLIST_TRACKS[0];
  }

  public getCurrentClientTrack(): MusicTrack {
    return PLAYLIST_TRACKS[this.state.clientTrackIndex] ?? PLAYLIST_TRACKS[0];
  }

  public pauseAll() {
    try {
      if (this.clientPlayer) {
        this.clientPlayer.pause();
        this.clientPlayer.volume = 0;
      }
      this.state.clientIsPlaying = false;
    } catch {}
    try {
      if (this.radioPlayer) {
        this.radioPlayer.pause();
        this.radioPlayer.volume = 0;
      }
    } catch {}
    this.notify();
  }
}

export const MusicService = new MusicServiceManager();
