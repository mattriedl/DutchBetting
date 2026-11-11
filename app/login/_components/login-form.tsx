'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart3, Eye, EyeOff, LogIn, UserPlus } from 'lucide-react';
import { toast } from 'sonner';

export function LoginForm({ allowSignup = false }: { allowSignup?: boolean }) {
  const router = useRouter();
  const [isLogin, setIsLogin] = useState(true);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', name: '' });

  const handleSubmit = async (e: React.FormEvent) => {
    e?.preventDefault?.();
    setLoading(true);

    try {
      if (isLogin) {
        const result = await signIn('credentials', {
          email: form?.email ?? '',
          password: form?.password ?? '',
          redirect: false,
        });
        if (result?.error) {
          toast.error('Invalid email or password');
        } else {
          router.replace('/dashboard');
        }
      } else {
        const res = await fetch('/api/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        });
        const data = await res?.json?.();
        if (!res?.ok) {
          toast.error(data?.error ?? 'Signup failed');
        } else {
          const signInResult = await signIn('credentials', {
            email: form?.email ?? '',
            password: form?.password ?? '',
            redirect: false,
          });
          if (signInResult?.error) {
            toast.error('Account created but login failed. Please try logging in.');
            setIsLogin(true);
          } else {
            router.replace('/dashboard');
          }
        }
      }
    } catch (error: any) {
      console.error('Auth error:', error);
      toast.error('An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="w-full max-w-md relative z-10 border-blue-800/30 bg-slate-900/80 backdrop-blur-xl shadow-2xl shadow-blue-950/50">
      <CardHeader className="text-center space-y-3">
        <div className="mx-auto w-14 h-14 rounded-xl bg-gradient-to-br from-blue-500 to-emerald-500 flex items-center justify-center shadow-lg shadow-blue-500/25">
          <BarChart3 className="w-7 h-7 text-white" />
        </div>
        <CardTitle className="text-2xl font-display tracking-tight text-white">
          Dutch Betting Dashboard
        </CardTitle>
        <CardDescription className="text-slate-400">
          Kalshi Climate Prediction Analysis
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {!isLogin && (
            <div className="space-y-2">
              <Label htmlFor="name" className="text-slate-300">Name</Label>
              <Input
                id="name"
                placeholder="Your name"
                value={form?.name ?? ''}
                onChange={(e: any) => setForm((prev: any) => ({ ...(prev ?? {}), name: e?.target?.value ?? '' }))}
                className="bg-slate-800/50 border-slate-700 text-white placeholder:text-slate-500"
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="email" className="text-slate-300">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              required
              value={form?.email ?? ''}
              onChange={(e: any) => setForm((prev: any) => ({ ...(prev ?? {}), email: e?.target?.value ?? '' }))}
              className="bg-slate-800/50 border-slate-700 text-white placeholder:text-slate-500"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password" className="text-slate-300">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                required
                value={form?.password ?? ''}
                onChange={(e: any) => setForm((prev: any) => ({ ...(prev ?? {}), password: e?.target?.value ?? '' }))}
                className="bg-slate-800/50 border-slate-700 text-white placeholder:text-slate-500 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <Button
            type="submit"
            className="w-full bg-gradient-to-r from-blue-600 to-emerald-600 hover:from-blue-500 hover:to-emerald-500 text-white shadow-lg"
            loading={loading}
          >
            {isLogin ? <LogIn className="w-4 h-4 mr-2" /> : <UserPlus className="w-4 h-4 mr-2" />}
            {isLogin ? 'Sign In' : 'Create Account'}
          </Button>
        </form>
        {allowSignup && (
        <div className="mt-6 text-center">
          <button
            onClick={() => setIsLogin(!isLogin)}
            className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
          >
            {isLogin ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
          </button>
        </div>
        )}
      </CardContent>
    </Card>
  );
}
