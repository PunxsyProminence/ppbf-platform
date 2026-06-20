'use client';
import React, { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error('PPBF Error Boundary caught:', error, errorInfo);
    // Log to Continuity Ledger in production
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || <div>Something went wrong. Please try again.</div>;
    }
    return this.props.children;
  }
}
