import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
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
import { AddaLogo } from '@/components/ui/AddaLogo';
import { useSession } from '@/context/session';
import { API_BASE_URL, authClient, authStorage } from '@/lib/auth-client';
import { configureGoogleSignIn } from '@/lib/google-sign-in';
import { clearSocialCache } from '@/lib/social-cache';
import { closeEncryptedChat } from '@/lib/encrypted-chat';

type AuthMode = 'login' | 'register';

export default function LoginScreen() {
  const { login } = useSession();
  const [mode, setMode] = useState<AuthMode>('login');

  // Form fields
  const [displayName, setDisplayName] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // OTP Verification state
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
  const [pendingPassword, setPendingPassword] = useState('');
  const [pendingName, setPendingName] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [resendLoading, setResendLoading] = useState(false);
  const [otpSuccessMessage, setOtpSuccessMessage] = useState('');

  // UI state
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  // Keyboard navigation & scroll refs
  const scrollViewRef = useRef<ScrollView>(null);
  const nameInputRef = useRef<TextInput>(null);
  const emailInputRef = useRef<TextInput>(null);
  const passwordInputRef = useRef<TextInput>(null);
  const confirmPasswordInputRef = useRef<TextInput>(null);
  const otpInputRef = useRef<TextInput>(null);
  const formYRef = useRef(0);
  const fieldRelY = useRef<Record<string, number>>({});

  useEffect(() => {
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    configureGoogleSignIn();

    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboardVisible(true)
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardVisible(false)
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Cooldown countdown timer for Resend OTP
  useEffect(() => {
    if (cooldown <= 0) return;
    const interval = setInterval(() => {
      setCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldown]);

  const scrollToField = (fieldKey: string) => {
    const delay = keyboardVisible ? 50 : Platform.OS === 'android' ? 120 : 40;
    setTimeout(() => {
      const relY = fieldRelY.current[fieldKey] ?? 0;
      const targetY = formYRef.current + relY;
      scrollViewRef.current?.scrollTo({
        y: Math.max(0, targetY - 20),
        animated: true,
      });
    }, delay);
  };

  const handleModeChange = (newMode: AuthMode) => {
    setMode(newMode);
    setError('');
    setIsVerifyingOtp(false);
    setOtpSuccessMessage('');
    fieldRelY.current = {};
    setTimeout(() => {
      scrollViewRef.current?.scrollTo({ y: 0, animated: true });
    }, 50);
  };

  const handleEmailAuth = async () => {
    setError('');
    setOtpSuccessMessage('');

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

      if (mode === 'register') {
        const result = await authClient.signUp.email({
          email,
          password,
          name: displayName.trim(),
        });
        if (result.error) {
          throw new Error(result.error.message || 'Registration failed');
        }
        // Seamlessly switch to OTP verification step
        setPendingEmail(email);
        setPendingPassword(password);
        setPendingName(displayName.trim());
        setIsVerifyingOtp(true);
        setOtpCode('');
        setCooldown(60);
        setOtpSuccessMessage('A 6-digit verification code has been sent to your email.');
        return;
      }

      // Login mode
      const result = await authClient.signIn.email({
        email,
        password,
      });
      if (result.error) {
        if (
          result.error.code === 'EMAIL_NOT_VERIFIED' ||
          result.error.message?.toLowerCase().includes('not verified')
        ) {
          // Guide unverified user into OTP verification
          setPendingEmail(email);
          setPendingPassword(password);
          setPendingName(identifier.trim());
          setIsVerifyingOtp(true);
          setOtpCode('');
          setCooldown(60);
          setOtpSuccessMessage('Please verify your email to log in. We sent a code to your email.');
          void authClient.emailOtp.sendVerificationOtp({
            email,
            type: 'email-verification',
          }).catch(() => {});
          return;
        }
        throw new Error(result.error.message || 'Sign in failed');
      }

      const authenticatedName = result.data?.user?.name || identifier.trim();
      const authenticatedId = (result as any)?.data?.user?.id;
      if (!(await authStorage.getAccessToken())) {
        throw new Error('Could not start your ADDA session. Please try again.');
      }
      clearSocialCache();
      await closeEncryptedChat();
      login(authenticatedName, authenticatedId);
      router.replace('/home');
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Authentication failed';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    setError('');
    setOtpSuccessMessage('');
    const code = otpCode.trim();
    if (!code || code.length < 6) {
      setError('Please enter the 6-digit code sent to your email.');
      return;
    }

    setLoading(true);
    try {
      const verifyRes = await authClient.emailOtp.verifyEmail({
        email: pendingEmail,
        otp: code,
      });

      if (verifyRes.error) {
        throw new Error(verifyRes.error.message || 'Invalid or expired verification code');
      }

      let token = await authStorage.getAccessToken();
      const verifyToken = (verifyRes.data as any)?.token;
      if (!token && typeof verifyToken === 'string' && verifyToken) {
        token = verifyToken;
        await authStorage.setAccessToken(verifyToken);
      }

      // If session token was not automatically created, establish it via password
      if (!token && pendingPassword) {
        const loginRes = await authClient.signIn.email({
          email: pendingEmail,
          password: pendingPassword,
        });
        const loginToken = (loginRes.data as any)?.token;
        if (typeof loginToken === 'string' && loginToken) {
          token = loginToken;
          await authStorage.setAccessToken(loginToken);
        }
      }

      if (!(await authStorage.getAccessToken())) {
        throw new Error('Could not establish session after verification. Please sign in with your password.');
      }

      clearSocialCache();
      await closeEncryptedChat();
      const authenticatedName = pendingName || (verifyRes.data as any)?.user?.name || pendingEmail;
      const authenticatedId = (verifyRes.data as any)?.user?.id;
      login(authenticatedName, authenticatedId);
      router.replace('/home');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Verification failed';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleResendOtp = async () => {
    if (cooldown > 0 || resendLoading) return;
    setResendLoading(true);
    setError('');
    setOtpSuccessMessage('');
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({
        email: pendingEmail,
        type: 'email-verification',
      });
      if (res.error) {
        throw new Error(res.error.message || 'Failed to resend code');
      }
      setOtpSuccessMessage('New verification code sent! Check your inbox.');
      setCooldown(60);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to resend verification code';
      setError(msg);
    } finally {
      setResendLoading(false);
    }
  };

  const handleBackFromOtp = () => {
    setIsVerifyingOtp(false);
    setOtpCode('');
    setError('');
    setOtpSuccessMessage('');
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
      await clearSocialCache();
      await closeEncryptedChat();

      // Authenticate with Better Auth backend via ID token
      try {
        const result = await authClient.signIn.social({
          provider: 'google',
          idToken: {
            token: idToken,
          },
          fetchOptions: {
            headers: {
              Origin: API_BASE_URL,
            },
          },
        });

        if (result.error) {
          throw new Error(result.error.message || 'Google sign-in verification failed on server');
        }
        const signedInEmail = result.data && 'user' in result.data ? result.data.user?.email?.toLowerCase() : undefined;
        if (!signedInEmail || signedInEmail !== chosenEmail) {
          await authStorage.clearTokens();
          await clearSocialCache();
          await closeEncryptedChat();
          await GoogleSignin.signOut();
          throw new Error('Google returned a different account than the one selected. Please choose again.');
        }

        let authenticatedName = displayNameFromGoogle;
        let authenticatedId: string | undefined = undefined;
        if (result.data && 'user' in result.data && result.data.user) {
          if (result.data.user.name) authenticatedName = result.data.user.name;
          if (result.data.user.id) authenticatedId = result.data.user.id;
        }
        if (!(await authStorage.getAccessToken())) throw new Error('Could not start your ADDA session. Please try again.');
        clearSocialCache();
        await closeEncryptedChat();
        login(authenticatedName, authenticatedId);
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
          ref={scrollViewRef}
          contentContainerStyle={[
            styles.content,
            keyboardVisible && styles.contentKeyboardActive,
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        >
          {isVerifyingOtp ? (
            <View style={styles.otpCard}>
              <View style={[styles.header, styles.headerCompact]}>
                <AddaLogo header compact centered showTagline={false} />
                <Text style={styles.otpHeaderTitle}>Verify Your Email</Text>
                <Text style={styles.otpHeaderSubtitle}>
                  We sent a 6-digit verification code to
                </Text>
                <View style={styles.otpEmailBadge}>
                  <Text style={styles.otpEmailText}>{pendingEmail}</Text>
                </View>
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.fieldLabel}>ENTER 6-DIGIT CODE</Text>
                <TextInput
                  ref={otpInputRef}
                  style={styles.otpInput}
                  placeholder="000000"
                  placeholderTextColor={colors.muted}
                  keyboardType="number-pad"
                  maxLength={6}
                  autoFocus
                  value={otpCode}
                  onChangeText={(val) => {
                    const clean = val.replace(/[^0-9]/g, '');
                    setOtpCode(clean);
                    if (clean.length === 6) {
                      setError('');
                    }
                  }}
                  returnKeyType="done"
                  onSubmitEditing={handleVerifyOtp}
                  accessibilityLabel="6-digit verification code"
                />
              </View>

              {!!otpSuccessMessage && (
                <View style={styles.otpSuccessContainer}>
                  <Text style={styles.otpSuccessText}>{otpSuccessMessage}</Text>
                </View>
              )}

              {!!error && (
                <View style={styles.errorContainer} accessibilityRole="alert">
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Verify and Complete Registration"
                onPress={handleVerifyOtp}
                disabled={loading || otpCode.trim().length < 6}
                style={({ pressed }) => [
                  styles.primaryButton,
                  pressed && styles.buttonPressed,
                  (loading || otpCode.trim().length < 6) && styles.buttonDisabled,
                ]}
              >
                {loading ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.primaryButtonText}>
                    Verify & Complete Registration  →
                  </Text>
                )}
              </Pressable>

              {/* Resend Code Section */}
              <View style={styles.resendRow}>
                {cooldown > 0 ? (
                  <Text style={styles.resendCooldownText}>
                    Resend code in {cooldown}s
                  </Text>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Resend code"
                    onPress={handleResendOtp}
                    disabled={resendLoading}
                  >
                    <Text style={styles.resendButtonText}>
                      {resendLoading ? 'Sending new code...' : "Didn't receive the email? Resend Code"}
                    </Text>
                  </Pressable>
                )}
              </View>

              {/* Back to Edit Details */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Go back to registration"
                onPress={handleBackFromOtp}
                style={styles.backOtpButton}
              >
                <Text style={styles.backOtpButtonText}>← Edit details / change email</Text>
              </Pressable>
            </View>
          ) : (
            <>
              {/* Brand Header */}
              <View style={[styles.header, keyboardVisible && styles.headerCompact]}>
                <AddaLogo
                  header={keyboardVisible}
                  compact={!keyboardVisible}
                  centered
                  showTagline={!keyboardVisible}
                />
                <Text style={[styles.introHeading, keyboardVisible && styles.introHeadingCompact]}>
                  {mode === 'login'
                    ? 'Welcome back to your spot'
                    : 'Create your account'}
                </Text>
              </View>

              {/* Mode Segmented Tab Switcher */}
              <View style={[styles.tabContainer, keyboardVisible && styles.tabContainerCompact]}>
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
              <View style={[styles.dividerRow, keyboardVisible && styles.dividerRowCompact]}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>OR WITH EMAIL</Text>
                <View style={styles.dividerLine} />
              </View>

              {/* Form */}
              <View
                style={styles.form}
                onLayout={(e) => {
                  formYRef.current = e.nativeEvent.layout.y;
                }}
              >
                {mode === 'register' && (
                  <View
                    style={styles.fieldGroup}
                    onLayout={(e) => {
                      fieldRelY.current.name = e.nativeEvent.layout.y;
                    }}
                  >
                    <Text style={styles.fieldLabel}>FULL NAME / NICKNAME</Text>
                    <TextInput
                      ref={nameInputRef}
                      style={styles.input}
                      placeholder="e.g. Kabir, Diya, Aarav"
                      placeholderTextColor={colors.muted}
                      autoCapitalize="words"
                      autoCorrect={false}
                      value={displayName}
                      onChangeText={setDisplayName}
                      returnKeyType="next"
                      onFocus={() => scrollToField('name')}
                      onSubmitEditing={() => emailInputRef.current?.focus()}
                      accessibilityLabel="Full name"
                    />
                  </View>
                )}

                <View
                  style={styles.fieldGroup}
                  onLayout={(e) => {
                    fieldRelY.current.email = e.nativeEvent.layout.y;
                  }}
                >
                  <Text style={styles.fieldLabel}>
                    EMAIL ADDRESS
                  </Text>
                  <TextInput
                    ref={emailInputRef}
                    style={styles.input}
                    placeholder="name@example.com"
                    placeholderTextColor={colors.muted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    value={identifier}
                    onChangeText={setIdentifier}
                    returnKeyType="next"
                    onFocus={() => scrollToField('email')}
                    onSubmitEditing={() => passwordInputRef.current?.focus()}
                    accessibilityLabel="Email address"
                  />
                </View>

                <View
                  style={styles.fieldGroup}
                  onLayout={(e) => {
                    fieldRelY.current.password = e.nativeEvent.layout.y;
                  }}
                >
                  <Text style={styles.fieldLabel}>PASSWORD</Text>
                  <TextInput
                    ref={passwordInputRef}
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
                    onFocus={() => scrollToField('password')}
                    onSubmitEditing={
                      mode === 'register'
                        ? () => confirmPasswordInputRef.current?.focus()
                        : handleEmailAuth
                    }
                    accessibilityLabel="Password"
                  />
                </View>

                {mode === 'register' && (
                  <View
                    style={styles.fieldGroup}
                    onLayout={(e) => {
                      fieldRelY.current.confirmPassword = e.nativeEvent.layout.y;
                    }}
                  >
                    <Text style={styles.fieldLabel}>CONFIRM PASSWORD</Text>
                    <TextInput
                      ref={confirmPasswordInputRef}
                      style={styles.input}
                      placeholder="Re-enter your password"
                      placeholderTextColor={colors.muted}
                      secureTextEntry
                      value={confirmPassword}
                      onChangeText={setConfirmPassword}
                      returnKeyType="go"
                      onFocus={() => scrollToField('confirmPassword')}
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
            </>
          )}

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
  contentKeyboardActive: {
    justifyContent: 'flex-start',
    paddingTop: 16,
    paddingBottom: Platform.OS === 'android' ? 280 : 140,
  },

  // Header lockup
  header: {
    alignItems: 'center',
    marginBottom: 24,
  },
  headerCompact: {
    marginBottom: 8,
    marginTop: 0,
  },
  introHeading: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginTop: 18,
    textAlign: 'center',
  },
  introHeadingCompact: {
    fontSize: 16,
    marginTop: 6,
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
  tabContainerCompact: {
    marginBottom: 12,
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
  dividerRowCompact: {
    marginVertical: 12,
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

  // OTP Verification View
  otpCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 20,
    padding: 24,
    gap: 12,
  },
  otpHeaderTitle: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '800',
    marginTop: 12,
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  otpHeaderSubtitle: {
    color: colors.muted,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 20,
  },
  otpEmailBadge: {
    alignSelf: 'center',
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 20,
    marginTop: 10,
    marginBottom: 8,
  },
  otpEmailText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '700',
  },
  otpInput: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.primary,
    borderWidth: 1.5,
    borderRadius: 14,
    color: colors.text,
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: 10,
    textAlign: 'center',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    minHeight: 64,
    paddingHorizontal: 16,
  },
  otpSuccessContainer: {
    backgroundColor: 'rgba(34, 197, 94, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(34, 197, 94, 0.35)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  otpSuccessText: {
    color: '#4ADE80',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 18,
  },
  resendRow: {
    alignItems: 'center',
    marginTop: 12,
  },
  resendCooldownText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
  },
  resendButtonText: {
    color: colors.primary,
    fontSize: 13.5,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  backOtpButton: {
    alignItems: 'center',
    marginTop: 8,
    paddingVertical: 8,
  },
  backOtpButtonText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
  },
});
