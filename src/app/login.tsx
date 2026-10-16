import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { router } from 'expo-router';
import {
  GoogleSignin,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import { colors } from '@/constants/theme';
import { useSession } from '@/context/session';
import { authClient, authStorage } from '@/lib/auth-client';
import { configureGoogleSignIn } from '@/lib/google-sign-in';

type AuthMode = 'login' | 'register';

export default function LoginScreen() {
  const { login } = useSession();
  const [mode, setMode] = useState<AuthMode>('login');

  // Form fields
  const [displayName, setDisplayName] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // UI state
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  useEffect(() => {
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    configureGoogleSignIn();
  }, []);

  const handleModeChange = (newMode: AuthMode) => {
    setMode(newMode);
    setError('');
  };

  const handleEmailAuth = async () => {
    setError('');

    if (mode === 'register') {
      if (!displayName.trim()) {
        setError('Please enter your name or nickname.');
        return;
      }
      if (!identifier.trim() || !identifier.includes('@')) {
        setError('Please enter your email address.');
        return;
      }
      if (!password || password.length < 6) {
        setError('Password must be at least 6 characters long.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
    } else {
      if (!identifier.trim() || !identifier.includes('@') || !password.trim()) {
        setError('Please enter your email and password.');
        return;
      }
    }

    setLoading(true);

    try {
      const email = identifier.trim().toLowerCase();

      let authenticatedName: string;
      if (mode === 'register') {
        const result = await authClient.signUp.email({
          email,
          password,
          name: displayName.trim(),
        });
        if (result.error) {
          throw new Error(result.error.message || 'Registration failed');
        }
        authenticatedName = displayName.trim();
      } else {
        const result = await authClient.signIn.email({
          email,
          password,
        });
        if (result.error) {
          throw new Error(result.error.message || 'Sign in failed');
        }
        authenticatedName = result.data?.user?.name || identifier.trim();
      }
      if (!(await authStorage.getAccessToken())) throw new Error('Could not start your ADDA session. Please try again.');
      login(authenticatedName);
      router.replace('/home');
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Authentication failed';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleAuth = async () => {
    setError('');
    setGoogleLoading(true);

    try {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      // Always release the previous native account before asking Google to sign in.
      await GoogleSignin.signOut().catch(() => {});
      const signInResult = await GoogleSignin.signIn();

      if (signInResult.type === 'cancelled') {
        // User closed or cancelled the account picker
        return;
      }

      const idToken = signInResult.data?.idToken;
      const userProfile = signInResult.data?.user;
      const displayNameFromGoogle =
        userProfile?.name ||
        userProfile?.givenName ||
        'Google Explorer';

      if (!idToken) {
        throw new Error('Google did not return an identity token. Please ensure Google Play Services are up to date.');
      }
      const chosenEmail = userProfile?.email?.trim().toLowerCase();
      if (!chosenEmail) throw new Error('Google did not return an email address. Please choose an account again.');
      const confirmed = await new Promise<boolean>(resolve => {
        Alert.alert('Use this Google account?', chosenEmail, [
          { text: 'Choose another', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Continue', onPress: () => resolve(true) },
        ], { cancelable: true, onDismiss: () => resolve(false) });
      });
      if (!confirmed) { await GoogleSignin.signOut(); return; }
      await authStorage.clearTokens();

      // Authenticate with Better Auth backend via ID token
      try {
        const result = await authClient.signIn.social({
          provider: 'google',
          idToken: {
            token: idToken,
          },
        });

        if (result.error) {
          throw new Error(result.error.message || 'Google sign-in verification failed on server');
        }
        const signedInEmail = result.data && 'user' in result.data ? result.data.user?.email?.toLowerCase() : undefined;
        if (!signedInEmail || signedInEmail !== chosenEmail) {
          await authStorage.clearTokens();
          await GoogleSignin.signOut();
          throw new Error('Google returned a different account than the one selected. Please choose again.');
        }

        let authenticatedName = displayNameFromGoogle;
        if (result.data && 'user' in result.data && result.data.user?.name) {
          authenticatedName = result.data.user.name;
        }
        if (!(await authStorage.getAccessToken())) throw new Error('Could not start your ADDA session. Please try again.');
        login(authenticatedName);
        router.replace('/home');
      } catch (serverErr: unknown) {
        const serverMessage =
          serverErr instanceof Error
            ? serverErr.message
            : 'Server authentication failed';

        throw new Error(serverMessage);
      }
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'code' in err) {
        const nativeErr = err as { code: string; message?: string };
        if (nativeErr.code === statusCodes.SIGN_IN_CANCELLED) {
          return;
        }
        if (nativeErr.code === statusCodes.IN_PROGRESS) {
          setError('Sign-in is already in progress.');
          return;
        }
        if (nativeErr.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
          setError('Google Play Services is not available or needs to be updated.');
          return;
        }
      }

      const message =
        err instanceof Error ? err.message : 'Google authentication failed';
      console.warn('Google sign-in error:', err);
      setError(message);
    } finally {
      setGoogleLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Brand Header */}
          <View style={styles.header}>
            <View style={styles.logoBadge}>
              <Text style={styles.logoChar}>अ</Text>
              <View style={styles.logoDot} />
            </View>
            <Text style={styles.brandTitle}>
              ADDA<Text style={styles.brandDot}>.</Text>
            </Text>
            <Text style={styles.tagline}>APNA VIRTUAL HANGOUT</Text>
            <Text style={styles.introHeading}>
              {mode === 'login'
                ? 'Welcome back to your spot'
                : 'Create your account'}
            </Text>
          </View>

          {/* Mode Segmented Tab Switcher */}
          <View style={styles.tabContainer}>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: mode === 'login' }}
              onPress={() => handleModeChange('login')}
              style={[styles.tab, mode === 'login' && styles.tabActive]}
            >
              <Text
                style={[
                  styles.tabText,
                  mode === 'login' && styles.tabTextActive,
                ]}
              >
                Sign In
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: mode === 'register' }}
              onPress={() => handleModeChange('register')}
              style={[styles.tab, mode === 'register' && styles.tabActive]}
            >
              <Text
                style={[
                  styles.tabText,
                  mode === 'register' && styles.tabTextActive,
                ]}
              >
                Create Account
              </Text>
            </Pressable>
          </View>

          {/* Google Sign-In Button */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Continue with Google"
            onPress={handleGoogleAuth}
            disabled={googleLoading || loading}
            style={({ pressed }) => [
              styles.googleButton,
              pressed && styles.buttonPressed,
              (googleLoading || loading) && styles.buttonDisabled,
            ]}
          >
            {googleLoading ? (
              <ActivityIndicator size="small" color="#1F1F1F" />
            ) : (
              <View style={styles.googleContentRow}>
                <Image
                  source={require('../../assets/images/google-g.png')}
                  style={styles.googleLogo}
                  resizeMode="contain"
                  accessibilityLabel="Google logo"
                />
                <Text style={styles.googleButtonText}>
                  {mode === 'login'
                    ? 'Sign in with Google'
                    : 'Sign up with Google'}
                </Text>
              </View>
            )}
          </Pressable>

          {/* Divider */}
          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>OR WITH EMAIL</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* Form */}
          <View style={styles.form}>
            {mode === 'register' && (
              <View style={styles.fieldGroup}>
                <Text style={styles.fieldLabel}>FULL NAME / NICKNAME</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Kabir, Diya, Aarav"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="words"
                  autoCorrect={false}
                  value={displayName}
                  onChangeText={setDisplayName}
                  returnKeyType="next"
                  accessibilityLabel="Full name"
                />
              </View>
            )}

            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>
                EMAIL ADDRESS
              </Text>
              <TextInput
                style={styles.input}
                placeholder="name@example.com"
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                value={identifier}
                onChangeText={setIdentifier}
                returnKeyType="next"
                accessibilityLabel="Email address"
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>PASSWORD</Text>
              <TextInput
                style={styles.input}
                placeholder={
                  mode === 'register'
                    ? 'At least 6 characters'
                    : 'Enter your password'
                }
                placeholderTextColor={colors.muted}
                secureTextEntry
                value={password}
                onChangeText={setPassword}
                returnKeyType={mode === 'register' ? 'next' : 'go'}
                onSubmitEditing={mode === 'login' ? handleEmailAuth : undefined}
                accessibilityLabel="Password"
              />
            </View>

            {mode === 'register' && (
              <View style={styles.fieldGroup}>
                <Text style={styles.fieldLabel}>CONFIRM PASSWORD</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Re-enter your password"
                  placeholderTextColor={colors.muted}
                  secureTextEntry
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  returnKeyType="go"
                  onSubmitEditing={handleEmailAuth}
                  accessibilityLabel="Confirm password"
                />
              </View>
            )}

            {!!error && (
              <View style={styles.errorContainer} accessibilityRole="alert">
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            {/* Primary Action Button */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                mode === 'login' ? 'Sign in to ADDA' : 'Create ADDA account'
              }
              onPress={handleEmailAuth}
              disabled={loading || googleLoading}
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && styles.buttonPressed,
                (loading || googleLoading) && styles.buttonDisabled,
              ]}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={styles.primaryButtonText}>
                  {mode === 'login'
                    ? 'Enter ADDA  →'
                    : 'Create Your Account  →'}
                </Text>
              )}
            </Pressable>
          </View>

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safe: { flex: 1, backgroundColor: colors.background },
  content: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 36,
    paddingBottom: 32,
    justifyContent: 'center',
  },

  // Header lockup
  header: {
    alignItems: 'center',
    marginBottom: 24,
  },
  logoBadge: {
    width: 60,
    height: 60,
    borderRadius: 20,
    backgroundColor: colors.primary,
    borderWidth: 1.5,
    borderColor: colors.primaryDark,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.14,
    shadowRadius: 14,
    elevation: 4,
  },
  logoChar: {
    color: '#FFFFFF',
    fontSize: 34,
    fontWeight: '900',
    includeFontPadding: false,
    lineHeight: 44,
  },
  logoDot: {
    position: 'absolute',
    top: 7,
    right: 7,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: colors.amber,
  },
  brandTitle: {
    color: colors.text,
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: -1.8,
    marginTop: 10,
  },
  brandDot: {
    color: colors.amber,
  },
  tagline: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 2.2,
    marginTop: 2,
  },
  introHeading: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginTop: 18,
    textAlign: 'center',
  },
  // Segmented Mode Switcher
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceRaised,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 4,
    marginBottom: 20,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 12,
  },
  tabActive: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  tabText: {
    color: colors.muted,
    fontSize: 13.5,
    fontWeight: '700',
  },
  tabTextActive: {
    color: colors.primaryDark,
  },

  // Google Button
  googleButton: {
    minHeight: 52,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#747775',
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 1,
  },
  googleContentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  googleLogo: {
    width: 24,
    height: 24,
  },
  googleButtonText: {
    color: '#1F1F1F',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.2,
  },

  // Divider
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 20,
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border,
  },
  dividerText: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.8,
  },

  // Form
  form: {
    gap: 12,
  },
  fieldGroup: {
    gap: 6,
  },
  fieldLabel: {
    color: colors.muted,
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1.4,
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    color: colors.text,
    fontSize: 15,
    minHeight: 52,
    paddingHorizontal: 16,
  },
  errorContainer: {
    backgroundColor: colors.errorSoft,
    borderWidth: 1,
    borderColor: '#F1C8CA',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 2,
  },
  errorText: {
    color: colors.error,
    fontSize: 12.5,
    fontWeight: '600',
    lineHeight: 17,
  },

  // Primary Button
  primaryButton: {
    minHeight: 52,
    backgroundColor: colors.primary,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.14,
    shadowRadius: 14,
    elevation: 3,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15.5,
    fontWeight: '800',
    letterSpacing: 0.3,
  },

  // Shared button states
  buttonPressed: {
    transform: [{ scale: 0.985 }],
    opacity: 0.9,
  },
  buttonDisabled: {
    opacity: 0.6,
  },

});
