import React, { useEffect, useState, useMemo } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  FlatList,
  StyleSheet,
  Pressable,
} from 'react-native';
import { MusicService, PLAYLIST_TRACKS, type MusicTrack, type MusicState } from '../../audio/MusicService';
import { Volume2, VolumeX, Play, Pause, SkipForward, SkipBack, Radio, Headphones, X, Search, Power } from 'lucide-react-native';

interface MusicHubModalProps {
  visible: boolean;
  onClose: () => void;
  initialTab?: 'headphones' | 'radio';
  onSyncRadioToServer?: (state: { enabled: boolean; trackIndex: number }) => void;
}

export const MusicHubModal: React.FC<MusicHubModalProps> = ({
  visible,
  onClose,
  initialTab = 'headphones',
  onSyncRadioToServer,
}) => {
  const [activeTab, setActiveTab] = useState<'headphones' | 'radio'>(initialTab);
  const [searchQuery, setSearchQuery] = useState('');
  const [musicState, setMusicState] = useState<MusicState>(MusicService.state);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    return MusicService.subscribe(setMusicState);
  }, []);

  const filteredTracks = useMemo(() => {
    if (!searchQuery.trim()) return PLAYLIST_TRACKS;
    const query = searchQuery.toLowerCase();
    return PLAYLIST_TRACKS.filter(t => t.title.toLowerCase().includes(query));
  }, [searchQuery]);

  const currentClientTrack = PLAYLIST_TRACKS[musicState.clientTrackIndex] ?? PLAYLIST_TRACKS[0];
  const currentRadioTrack = PLAYLIST_TRACKS[musicState.radioTrackIndex] ?? PLAYLIST_TRACKS[0];

  const handleSelectTrack = (track: MusicTrack) => {
    const index = PLAYLIST_TRACKS.findIndex(t => t.id === track.id);
    if (index === -1) return;

    if (activeTab === 'headphones') {
      MusicService.playClientTrack(index);
    } else {
      MusicService.playRadioTrack(index);
      onSyncRadioToServer?.({ enabled: musicState.radioEnabled, trackIndex: index });
    }
  };

  const handleToggleRadioPower = () => {
    const next = !musicState.radioEnabled;
    MusicService.setRadioEnabled(next);
    onSyncRadioToServer?.({ enabled: next, trackIndex: musicState.radioTrackIndex });
  };

  const handleRadioNext = () => {
    const nextIndex = (musicState.radioTrackIndex + 1) % PLAYLIST_TRACKS.length;
    MusicService.playRadioTrack(nextIndex);
    onSyncRadioToServer?.({ enabled: musicState.radioEnabled, trackIndex: nextIndex });
  };

  const handleRadioPrev = () => {
    const prevIndex = (musicState.radioTrackIndex - 1 + PLAYLIST_TRACKS.length) % PLAYLIST_TRACKS.length;
    MusicService.playRadioTrack(prevIndex);
    onSyncRadioToServer?.({ enabled: musicState.radioEnabled, trackIndex: prevIndex });
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.container} onPress={e => e.stopPropagation()}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <View style={styles.badgeIcon}>
                <Radio size={18} color="#00e5ff" />
              </View>
              <Text style={styles.title}>ADDA Music Studio</Text>
            </View>
            <TouchableOpacity style={styles.closeBtn} onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <X size={20} color="#a0aec0" />
            </TouchableOpacity>
          </View>

          {/* Dual Tabs */}
          <View style={styles.tabBar}>
            <TouchableOpacity
              style={[styles.tabItem, activeTab === 'headphones' && styles.tabItemActive]}
              onPress={() => setActiveTab('headphones')}
            >
              <Headphones size={16} color={activeTab === 'headphones' ? '#00e5ff' : '#718096'} />
              <Text style={[styles.tabLabel, activeTab === 'headphones' && styles.tabLabelActive]}>
                My Headphones
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.tabItem, activeTab === 'radio' && styles.tabItemActive]}
              onPress={() => setActiveTab('radio')}
            >
              <Radio size={16} color={activeTab === 'radio' ? '#ff9100' : '#718096'} />
              <Text style={[styles.tabLabel, activeTab === 'radio' && styles.tabLabelActive]}>
                In-World Radio (3D)
              </Text>
            </TouchableOpacity>
          </View>

          {/* Active Player Card */}
          {activeTab === 'headphones' ? (
            <View style={styles.nowPlayingCard}>
              <View style={styles.nowPlayingHeader}>
                <Text style={styles.channelBadge}>PERSONAL 2D AUDIO</Text>
                <TouchableOpacity
                  style={[styles.muteBtn, musicState.clientMuted && styles.muteBtnActive]}
                  onPress={() => MusicService.toggleClientMute()}
                >
                  {musicState.clientMuted ? <VolumeX size={15} color="#ff5252" /> : <Volume2 size={15} color="#00e5ff" />}
                  <Text style={[styles.muteBtnText, musicState.clientMuted && { color: '#ff5252' }]}>
                    {musicState.clientMuted ? 'Muted' : `${Math.round(musicState.clientVolume * 100)}%`}
                  </Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.nowPlayingTitle} numberOfLines={1}>
                {currentClientTrack.title}
              </Text>

              {/* Volume Slider Controls */}
              <View style={styles.volumeRow}>
                <Text style={styles.volumeLabel}>Volume</Text>
                <TouchableOpacity
                  style={styles.volStepBtn}
                  onPress={() => MusicService.setClientVolume(musicState.clientVolume - 0.1)}
                >
                  <Text style={styles.volStepText}>−</Text>
                </TouchableOpacity>
                <View style={styles.volBarTrack}>
                  <View style={[styles.volBarFill, { width: `${musicState.clientMuted ? 0 : musicState.clientVolume * 100}%` }]} />
                </View>
                <TouchableOpacity
                  style={styles.volStepBtn}
                  onPress={() => MusicService.setClientVolume(musicState.clientVolume + 0.1)}
                >
                  <Text style={styles.volStepText}>+</Text>
                </TouchableOpacity>
              </View>

              {/* Playback Controls */}
              <View style={styles.controlsRow}>
                <TouchableOpacity style={styles.controlBtn} onPress={() => MusicService.prevClientTrack()}>
                  <SkipBack size={18} color="#e2e8f0" />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.playBtn, musicState.clientIsPlaying && styles.playBtnActive]}
                  onPress={() => MusicService.toggleClientPlay()}
                >
                  {musicState.clientIsPlaying ? (
                    <Pause size={20} color="#000" fill="#000" />
                  ) : (
                    <Play size={20} color="#000" fill="#000" />
                  )}
                </TouchableOpacity>
                <TouchableOpacity style={styles.controlBtn} onPress={() => MusicService.nextClientTrack()}>
                  <SkipForward size={18} color="#e2e8f0" />
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <View style={[styles.nowPlayingCard, styles.radioCard]}>
              <View style={styles.nowPlayingHeader}>
                <View style={styles.radioStatusRow}>
                  <View style={[styles.powerLed, { backgroundColor: musicState.radioEnabled ? '#00e676' : '#ff1744' }]} />
                  <Text style={[styles.channelBadge, { color: '#ff9100' }]}>
                    {musicState.radioEnabled ? '3D SPATIAL BROADCAST: ON' : 'RADIO TURNED OFF'}
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.powerToggleBtn, musicState.radioEnabled && styles.powerToggleBtnOn]}
                  onPress={handleToggleRadioPower}
                >
                  <Power size={14} color={musicState.radioEnabled ? '#00e676' : '#a0aec0'} />
                  <Text style={[styles.powerToggleText, musicState.radioEnabled && { color: '#00e676' }]}>
                    {musicState.radioEnabled ? 'Power ON' : 'Power OFF'}
                  </Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.nowPlayingTitle} numberOfLines={1}>
                {musicState.radioEnabled ? currentRadioTrack.title : 'Radio is powered off'}
              </Text>
              <Text style={styles.radioSubtext}>
                {musicState.radioEnabled
                  ? `Spatial Sound: Fades out smoothly as you walk away in 3D`
                  : 'Turn on power to broadcast music to everyone in this room'}
              </Text>

              {/* Radio Volume Slider */}
              <View style={styles.volumeRow}>
                <Text style={styles.volumeLabel}>Speaker</Text>
                <TouchableOpacity
                  style={styles.volStepBtn}
                  onPress={() => MusicService.setRadioVolume(musicState.radioVolume - 0.1)}
                >
                  <Text style={styles.volStepText}>−</Text>
                </TouchableOpacity>
                <View style={styles.volBarTrack}>
                  <View style={[styles.volBarFill, { width: `${musicState.radioMuted || !musicState.radioEnabled ? 0 : musicState.radioVolume * 100}%`, backgroundColor: '#ff9100' }]} />
                </View>
                <TouchableOpacity
                  style={styles.volStepBtn}
                  onPress={() => MusicService.setRadioVolume(musicState.radioVolume + 0.1)}
                >
                  <Text style={styles.volStepText}>+</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.muteBtnSmall, musicState.radioMuted && styles.muteBtnActive]}
                  onPress={() => MusicService.toggleRadioMute()}
                >
                  {musicState.radioMuted ? <VolumeX size={14} color="#ff5252" /> : <Volume2 size={14} color="#ff9100" />}
                </TouchableOpacity>
              </View>

              {/* Radio Controls */}
              <View style={styles.controlsRow}>
                <TouchableOpacity style={styles.controlBtn} onPress={handleRadioPrev}>
                  <SkipBack size={18} color="#e2e8f0" />
                </TouchableOpacity>
                <View style={styles.stationPill}>
                  <Text style={styles.stationPillText}>STATION CH-{musicState.radioTrackIndex + 1}</Text>
                </View>
                <TouchableOpacity style={styles.controlBtn} onPress={handleRadioNext}>
                  <SkipForward size={18} color="#e2e8f0" />
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Search Bar */}
          <View style={styles.searchBox}>
            <Search size={16} color="#718096" style={styles.searchIcon} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search 32 English X Hindi mashup songs..."
              placeholderTextColor="#718096"
              value={searchQuery}
              onChangeText={setSearchQuery}
              clearButtonMode="while-editing"
            />
          </View>

          {/* Playlist Track Items */}
          <FlatList
            data={filteredTracks}
            keyExtractor={item => item.id}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            renderItem={({ item, index }) => {
              const originalIndex = PLAYLIST_TRACKS.findIndex(t => t.id === item.id);
              const isSelected =
                activeTab === 'headphones'
                  ? musicState.clientTrackIndex === originalIndex
                  : musicState.radioTrackIndex === originalIndex;

              return (
                <TouchableOpacity
                  style={[styles.trackRow, isSelected && styles.trackRowSelected]}
                  onPress={() => handleSelectTrack(item)}
                >
                  <View style={[styles.trackIndexBadge, isSelected && styles.trackIndexBadgeActive]}>
                    <Text style={[styles.trackIndexText, isSelected && styles.trackIndexTextActive]}>
                      {originalIndex + 1}
                    </Text>
                  </View>
                  <View style={styles.trackInfo}>
                    <Text style={[styles.trackTitle, isSelected && styles.trackTitleActive]} numberOfLines={1}>
                      {item.title}
                    </Text>
                    <Text style={styles.trackSub} numberOfLines={1}>
                      English X Hindi Mashup
                    </Text>
                  </View>
                  {isSelected && (
                    <View style={styles.playingIndicator}>
                      <View style={[styles.eqBar, styles.eqBar1]} />
                      <View style={[styles.eqBar, styles.eqBar2]} />
                      <View style={[styles.eqBar, styles.eqBar3]} />
                    </View>
                  )}
                </TouchableOpacity>
              );
            }}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(5, 8, 15, 0.82)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  container: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '85%',
    backgroundColor: '#0f141d',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    overflow: 'hidden',
    shadowColor: '#00e5ff',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.06)',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  badgeIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: 'rgba(0, 229, 255, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#f8fafc',
    letterSpacing: 0.2,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    padding: 6,
    marginHorizontal: 16,
    marginTop: 14,
    borderRadius: 12,
    gap: 6,
  },
  tabItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    borderRadius: 8,
    gap: 8,
  },
  tabItemActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  tabLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#718096',
  },
  tabLabelActive: {
    color: '#f8fafc',
  },
  nowPlayingCard: {
    backgroundColor: 'rgba(0, 229, 255, 0.04)',
    marginHorizontal: 16,
    marginTop: 14,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(0, 229, 255, 0.15)',
  },
  radioCard: {
    backgroundColor: 'rgba(255, 145, 0, 0.04)',
    borderColor: 'rgba(255, 145, 0, 0.2)',
  },
  nowPlayingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  channelBadge: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: '#00e5ff',
  },
  radioStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  powerLed: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  powerToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
  },
  powerToggleBtnOn: {
    backgroundColor: 'rgba(0, 230, 118, 0.15)',
  },
  powerToggleText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#a0aec0',
  },
  muteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  muteBtnSmall: {
    padding: 6,
    borderRadius: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    marginLeft: 6,
  },
  muteBtnActive: {
    backgroundColor: 'rgba(255, 82, 82, 0.15)',
  },
  muteBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#00e5ff',
  },
  nowPlayingTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#f8fafc',
    marginBottom: 2,
  },
  radioSubtext: {
    fontSize: 11,
    color: '#718096',
    marginBottom: 6,
  },
  volumeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 8,
    gap: 8,
  },
  volumeLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#a0aec0',
    width: 46,
  },
  volStepBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  volStepText: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#e2e8f0',
    lineHeight: 18,
  },
  volBarTrack: {
    flex: 1,
    height: 5,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  volBarFill: {
    height: '100%',
    backgroundColor: '#00e5ff',
    borderRadius: 3,
  },
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 18,
    marginTop: 4,
  },
  controlBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  playBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#00e5ff',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#00e5ff',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 4,
  },
  playBtnActive: {
    backgroundColor: '#39ff14',
  },
  stationPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 145, 0, 0.15)',
  },
  stationPillText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#ff9100',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    height: 38,
    fontSize: 13,
    color: '#f8fafc',
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 20,
  },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginBottom: 4,
  },
  trackRowSelected: {
    backgroundColor: 'rgba(0, 229, 255, 0.08)',
  },
  trackIndexBadge: {
    width: 24,
    height: 24,
    borderRadius: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  trackIndexBadgeActive: {
    backgroundColor: '#00e5ff',
  },
  trackIndexText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#718096',
  },
  trackIndexTextActive: {
    color: '#000',
  },
  trackInfo: {
    flex: 1,
  },
  trackTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#e2e8f0',
  },
  trackTitleActive: {
    color: '#00e5ff',
    fontWeight: '700',
  },
  trackSub: {
    fontSize: 11,
    color: '#718096',
    marginTop: 2,
  },
  playingIndicator: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 3,
    height: 14,
    marginLeft: 8,
  },
  eqBar: {
    width: 3,
    backgroundColor: '#00e5ff',
    borderRadius: 2,
  },
  eqBar1: { height: 8 },
  eqBar2: { height: 14 },
  eqBar3: { height: 10 },
});
