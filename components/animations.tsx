'use client';

import React from 'react';

interface AnimationProps {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}

export function FadeIn({ children, className = '', delay = 0 }: AnimationProps) {
  return (
    <div
      className={`animate-in fade-in duration-500 ${className}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

export function Stagger({ children, className = '' }: AnimationProps) {
  return <div className={className}>{children}</div>;
}

export function StaggerItem({ children, className = '' }: AnimationProps) {
  return (
    <div className={`animate-in fade-in slide-in-from-bottom-2 duration-500 ${className}`}>
      {children}
    </div>
  );
}
