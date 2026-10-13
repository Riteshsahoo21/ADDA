import { Redirect } from 'expo-router';
import { useSession } from '@/context/session';

export default function Index() {
  const { username } = useSession();
  return <Redirect href={username ? '/home' : '/login'} />;
}
