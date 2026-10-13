import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { router } from 'expo-router';
import { ActionButton } from '@/components/ui/ActionButton';
import { colors } from '@/constants/theme';
import { useSession } from '@/context/session';

export default function LoginScreen() {
  const { login } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP); }, []);

  const submit = () => {
    if (!username.trim() || !password.trim()) {
      setError('Enter a username and password to continue.');
      return;
    }
    setError('');
    setLoading(true);
    setTimeout(() => {
      login(username.trim());
      setLoading(false);
      router.replace('/home');
    }, 350);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.mark}><Text style={styles.markText}>अ</Text></View>
          <Text style={styles.brand}>ADDA<Text style={styles.dot}>.</Text></Text>
          <Text style={styles.tagline}>Apna Virtual Hangout</Text>
          <View style={styles.intro}>
            <Text style={styles.heading}>Your people. Your place.</Text>
            <Text style={styles.copy}>A little room for your favourite people, wherever you are.</Text>
          </View>
          <View style={styles.form}>
            <Text style={styles.fieldLabel}>USERNAME</Text>
            <TextInput style={styles.input} placeholder="What should we call you?" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} value={username} onChangeText={setUsername} returnKeyType="next" accessibilityLabel="Username" />
            <Text style={styles.fieldLabel}>PASSWORD</Text>
            <TextInput style={styles.input} placeholder="Any password for this demo" placeholderTextColor={colors.muted} secureTextEntry value={password} onChangeText={setPassword} onSubmitEditing={submit} returnKeyType="go" accessibilityLabel="Password" />
            {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            <ActionButton label={loading ? 'Entering your adda…' : 'Enter ADDA'} onPress={submit} disabled={loading} style={styles.button} />
          </View>
          <Text style={styles.note}>DEMO ACCESS  ·  ANY NONEMPTY CREDENTIALS</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 }, safe: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, paddingHorizontal: 28, paddingTop: 52, paddingBottom: 32, justifyContent: 'center' },
  mark: { width: 66, height: 66, borderRadius: 22, backgroundColor: colors.purple, alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  markText: { color: '#22133F', fontSize: 39, fontWeight: '900' },
  brand: { color: colors.text, fontSize: 51, fontWeight: '900', letterSpacing: -3 },
  dot: { color: colors.purple },
  tagline: { color: colors.purple, fontSize: 15, fontWeight: '700', letterSpacing: 2.1, marginTop: 1 },
  intro: { marginTop: 54, marginBottom: 33 },
  heading: { color: colors.text, fontSize: 29, fontWeight: '800', letterSpacing: -0.8 },
  copy: { color: colors.muted, fontSize: 15, lineHeight: 23, marginTop: 10, maxWidth: 300 },
  form: { gap: 9 },
  fieldLabel: { color: colors.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1.7, marginTop: 11 },
  input: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 15, color: colors.text, fontSize: 16, minHeight: 56, paddingHorizontal: 17 },
  error: { color: colors.error, fontSize: 13, marginTop: 3 },
  button: { marginTop: 20 },
  note: { color: colors.muted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, textAlign: 'center', marginTop: 28 },
});
