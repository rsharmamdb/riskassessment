"use client";

import { ButtonHTMLAttributes, forwardRef, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "primary", size = "md", loading, children, className, disabled, ...rest },
    ref,
  ) {
    const base =
      "inline-flex items-center justify-center gap-1.5 font-medium transition-colors text-[13px] disabled:opacity-40 disabled:cursor-not-allowed";
    const sizes = {
      sm: "px-3 py-1.5",
      md: "px-3.5 py-2",
    };
    const variants = {
      primary: "bg-accent-500 text-white hover:bg-accent-600",
      secondary:
        "bg-transparent text-ink-300 border border-ink-600 hover:bg-ink-900 hover:border-ink-500 hover:text-ink-100",
      ghost: "text-ink-400 hover:text-ink-100 hover:bg-ink-900",
      danger: "bg-transparent text-danger border border-danger/40 hover:bg-danger/10 hover:border-danger",
    };
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={`${base} ${sizes[size]} ${variants[variant]} ${className ?? ""}`}
        style={{ borderRadius: '3px' }}
        {...rest}
      >
        {loading && (
          <span className="w-3.5 h-3.5 rounded-full border-2 border-accent-500/30 border-t-accent-500 animate-spin" />
        )}
        {children}
      </button>
    );
  },
);

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`border border-ink-700 bg-ink-800 ${className ?? ""}`}
      style={{ borderRadius: "8px" }}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  right,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between px-4 py-3 border-b border-ink-700">
      <div>
        <div className="text-[13px] font-medium text-ink-200">{title}</div>
        {subtitle && (
          <div className="text-[11px] text-ink-400 mt-0.5 max-w-xl">{subtitle}</div>
        )}
      </div>
      {right}
    </div>
  );
}

export function CardBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`p-4 ${className ?? ""}`}>{children}</div>;
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <label className="mb-1 block text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-300">
      {children}
    </label>
  );
}

export function Input(
  props: React.InputHTMLAttributes<HTMLInputElement>,
) {
  const { className, ...rest } = props;
  return (
    <input
      {...rest}
      className={`w-full border border-ink-700 bg-accent-900 px-3 py-2 text-[13px] text-ink-100 placeholder:text-ink-500 outline-none transition-colors focus:border-accent-500 focus:ring-0 ${className ?? ""}`}
      style={{ borderRadius: "6px" }}
    />
  );
}

export function Textarea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  const { className, ...rest } = props;
  return (
    <textarea
      {...rest}
      className={`w-full border border-ink-700 bg-accent-900 px-3 py-2 text-[13px] leading-relaxed text-ink-100 placeholder:text-ink-500 outline-none transition-colors focus:border-accent-500 focus:ring-0 ${className ?? ""}`}
      style={{ borderRadius: "6px" }}
    />
  );
}

export function Select(
  props: React.SelectHTMLAttributes<HTMLSelectElement>,
) {
  const { className, children, ...rest } = props;
  return (
    <select
      {...rest}
      className={`w-full border border-ink-700 bg-accent-900 px-3 py-2 text-[13px] text-ink-100 outline-none transition-colors focus:border-accent-500 focus:ring-0 ${className ?? ""}`}
      style={{ borderRadius: "6px" }}
    >
      {children}
    </select>
  );
}

export function Pill({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "success" | "warn" | "danger" | "accent";
}) {
  const tones = {
    default: "text-ink-400 border-ink-700/80 bg-accent-900",
    success: "text-success border-success/35 bg-success/10",
    warn:    "text-warn border-warn/35 bg-warn/10",
    danger:  "text-danger border-danger/35 bg-danger/10",
    accent:  "text-accent-400 border-accent-500/35 bg-accent-500/10",
  };
  return (
    <span
      className={`inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full border ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function CopyButton({ text }: { text: string }) {
  return (
    <Button
      size="sm"
      variant="secondary"
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text);
      }}
    >
      Copy
    </Button>
  );
}
