import { createAudioPlayer, type AudioPlayer } from 'expo-audio';

// Local synthesized audio assets
/* eslint-disable @typescript-eslint/no-require-imports */
const SENT_SOUND = require('../../assets/sounds/msg_sent.wav');
const RECEIVED_SOUND = require('../../assets/sounds/msg_received.wav');
const FOOTSTEP_1 = require('../../assets/sounds/footstep1.wav');
const FOOTSTEP_2 = require('../../assets/sounds/footstep2.wav');
/* eslint-enable @typescript-eslint/no-require-imports */

class SoundEffectsService {
  private sentPlayer: AudioPlayer | null = null;
  private receivedPlayer: AudioPlayer | null = null;
  private step1Player: AudioPlayer | null = null;
  private step2Player: AudioPlayer | null = null;
  private lastStepTime = 0;
  private lastSentTime = 0;
  private lastReceivedTime = 0;
  private stepAlternator = false;

  private getSentPlayer(): AudioPlayer | null {
    if (!this.sentPlayer) {
      try {
        this.sentPlayer = createAudioPlayer(SENT_SOUND);
        this.sentPlayer.volume = 0.85;
      } catch (e) {
        console.warn('[SoundEffects] Failed to create sent player:', e);
      }
    }
    return this.sentPlayer;
  }

  private getReceivedPlayer(): AudioPlayer | null {
    if (!this.receivedPlayer) {
      try {
        this.receivedPlayer = createAudioPlayer(RECEIVED_SOUND);
        this.receivedPlayer.volume = 0.80;
      } catch (e) {
        console.warn('[SoundEffects] Failed to create received player:', e);
      }
    }
    return this.receivedPlayer;
  }

  private getStepPlayer(isAlternate: boolean): AudioPlayer | null {
    if (isAlternate) {
      if (!this.step2Player) {
        try {
          this.step2Player = createAudioPlayer(FOOTSTEP_2);
          this.step2Player.volume = 0.20; // Very very light!
        } catch (e) {
          console.warn('[SoundEffects] Failed to create step2 player:', e);
        }
      }
      return this.step2Player;
    } else {
      if (!this.step1Player) {
        try {
          this.step1Player = createAudioPlayer(FOOTSTEP_1);
          this.step1Player.volume = 0.20; // Very very light!
        } catch (e) {
          console.warn('[SoundEffects] Failed to create step1 player:', e);
        }
      }
      return this.step1Player;
    }
  }

  /**
   * Crisp 'tick' sound when user sends a message.
   * Only played when an active conversation / chat is open.
   * Debounced to 250ms to prevent double-click stutter.
   */
  public playSent(): void {
    const now = Date.now();
    if (now - this.lastSentTime < 250) return;
    this.lastSentTime = now;

    try {
      const p = this.getSentPlayer();
      if (p) {
        void p.seekTo(0).then(() => p.play()).catch(() => p.play());
      }
    } catch (e) {
      console.warn('[SoundEffects] playSent error:', e);
    }
  }

  /**
   * Gentle, pleasant incoming message chime/pop.
   * Only played when the user is actively viewing that live 1:1 or group conversation.
   * Debounced to 250ms to prevent duplicate simultaneous envelopes from double-playing.
   */
  public playReceived(): void {
    const now = Date.now();
    if (now - this.lastReceivedTime < 250) return;
    this.lastReceivedTime = now;

    try {
      const p = this.getReceivedPlayer();
      if (p) {
        void p.seekTo(0).then(() => p.play()).catch(() => p.play());
      }
    } catch (e) {
      console.warn('[SoundEffects] playReceived error:', e);
    }
  }

  /**
   * Very light walking sound for the local player only.
   * Alternates left/right soft footsteps timed to walking cadence (~360ms walking, ~260ms running).
   */
  public playFootstep(running = false): void {
    const now = Date.now();
    const interval = running ? 260 : 360;
    if (now - this.lastStepTime < interval) return;
    this.lastStepTime = now;
    this.stepAlternator = !this.stepAlternator;

    try {
      const p = this.getStepPlayer(this.stepAlternator);
      if (p) {
        p.volume = running ? 0.22 : 0.16; // Very light, cushioned tap
        void p.seekTo(0).then(() => p.play()).catch(() => p.play());
      }
    } catch (e) {
      console.warn('[SoundEffects] playFootstep error:', e);
    }
  }
}

export const SoundEffects = new SoundEffectsService();
