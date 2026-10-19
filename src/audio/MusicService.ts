import { createVideoPlayer, type VideoPlayer } from 'expo-video';
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

  private getTrackUrl(id: string): string {
    return `${API_BASE_URL}/music/${id}.m4a`;
  }

  public init() {
    if (this.clientPlayer || PLAYLIST_TRACKS.length === 0) return;

    try {
      const firstUrl = this.getTrackUrl(PLAYLIST_TRACKS[this.state.clientTrackIndex].id);
      this.currentClientUrl = firstUrl;
      console.log('[ADDA Music] Initializing client player:', firstUrl);
      this.clientPlayer = createVideoPlayer(firstUrl);
      this.clientPlayer.audioMixingMode = 'mixWithOthers';
      this.clientPlayer.loop = true;
      this.clientPlayer.volume = this.state.clientMuted ? 0 : this.state.clientVolume;
      this.clientPlayer.addListener('statusChange', (payload: any) => {
        console.log('[ADDA Music] Client player status:', payload?.status, payload?.error?.message ?? '');
      });

      const radioUrl = this.getTrackUrl(PLAYLIST_TRACKS[this.state.radioTrackIndex].id);
      this.currentRadioUrl = radioUrl;
      console.log('[ADDA Music] Initializing radio player:', radioUrl);
      this.radioPlayer = createVideoPlayer(radioUrl);
      this.radioPlayer.audioMixingMode = 'mixWithOthers';
      this.radioPlayer.loop = true;
      this.radioPlayer.addListener('statusChange', (payload: any) => {
        console.log('[ADDA Music] Radio player status:', payload?.status, payload?.error?.message ?? '');
      });
      this.updateEffectiveRadioVolume();
      if (this.state.radioEnabled) {
        this.radioPlayer.play();
      }
    } catch (e) {
      console.warn('[ADDA Music] Failed to initialize audio players', e);
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
    this.init();
    if (!this.clientPlayer) return;
    if (this.state.clientIsPlaying) {
      this.clientPlayer.pause();
      this.state.clientIsPlaying = false;
    } else {
      this.clientPlayer.play();
      this.state.clientIsPlaying = true;
    }
    this.notify();
  }

  public playClientTrack(index: number) {
    this.init();
    if (index < 0 || index >= PLAYLIST_TRACKS.length) return;
    const trackChanged = this.state.clientTrackIndex !== index;
    this.state.clientTrackIndex = index;
    if (this.clientPlayer) {
      const url = this.getTrackUrl(PLAYLIST_TRACKS[index].id);
      if (trackChanged || this.currentClientUrl !== url) {
        this.currentClientUrl = url;
        console.log('[ADDA Music] Replacing client track:', index, url);
        this.clientPlayer.replace(url);
      }
      this.clientPlayer.volume = this.state.clientMuted ? 0 : this.state.clientVolume;
      this.clientPlayer.play();
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
    this.init();
    if (this.state.radioEnabled === enabled && !force) return;
    this.state.radioEnabled = enabled;
    if (this.radioPlayer) {
      if (enabled) {
        this.updateEffectiveRadioVolume();
        this.radioPlayer.play();
      } else {
        this.radioPlayer.pause();
        this.lastAppliedRadioVolume = 0;
        this.radioPlayer.volume = 0;
      }
    }
    this.notify();
  }

  public playRadioTrack(index: number, seekSeconds = 0) {
    this.init();
    if (index < 0 || index >= PLAYLIST_TRACKS.length) return;
    const trackChanged = this.state.radioTrackIndex !== index;
    this.state.radioTrackIndex = index;
    if (this.radioPlayer) {
      const url = this.getTrackUrl(PLAYLIST_TRACKS[index].id);
      if (trackChanged || this.currentRadioUrl !== url) {
        this.currentRadioUrl = url;
        console.log('[ADDA Music] Replacing radio track:', index, url);
        this.radioPlayer.replace(url);
        if (seekSeconds > 0) {
          this.radioPlayer.currentTime = seekSeconds;
        }
      }
      if (this.state.radioEnabled) {
        this.updateEffectiveRadioVolume();
        this.radioPlayer.play();
      } else {
        this.radioPlayer.pause();
        this.lastAppliedRadioVolume = 0;
        this.radioPlayer.volume = 0;
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
   * Only calls native bridge if attenuation change is significant, eliminating lag!
   * @param attenuation 0.0 (too far) to 1.0 (right beside the radio)
   */
  public updateSpatialAttenuation(attenuation: number) {
    const clamped = Math.max(0, Math.min(1, attenuation));
    // Skip if difference is negligible to save native bridge calls
    if (Math.abs(clamped - this.state.radio3DAttenuation) < 0.015) {
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

    // Only update native volume if it changed by at least 1%
    if (Math.abs(targetVolume - this.lastAppliedRadioVolume) >= 0.01) {
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
