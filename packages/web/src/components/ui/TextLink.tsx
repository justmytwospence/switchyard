import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { Link, type LinkProps } from "react-router";
import { cn } from "../../lib/cn";

type Common = {
  children: ReactNode;
  icon?: ReactNode;
  size?: "xs" | "sm" | "inherit";
  /** "inline" underlines (default for links); "action" underlines on hover (default for buttons). */
  variant?: "inline" | "action";
  className?: string;
};

export type TextLinkProps =
  | (Common & { to: string } & Omit<LinkProps, "className" | "children" | "to">)
  | (Common & { href: string; external?: boolean } & Omit<
        AnchorHTMLAttributes<HTMLAnchorElement>,
        "className" | "children" | "href"
      >)
  | (Common & { to?: undefined; href?: undefined } & Omit<
        ButtonHTMLAttributes<HTMLButtonElement>,
        "className" | "children"
      >);

const SIZES = { xs: "text-xs", sm: "text-sm", inherit: "" } as const;

/** A link or link-styled button for text. Always inline-flex so `.tap` can size its touch target. */
export function TextLink(props: TextLinkProps) {
  const { icon, size = "inherit", variant, className, children } = props;
  const isLink = "to" in props && props.to !== undefined;
  const isAnchor = "href" in props && props.href !== undefined;
  const style = cn(
    "tap inline-flex min-w-0 items-center gap-1 rounded-sm text-left font-medium text-accent underline-offset-2",
    (variant ?? (isLink || isAnchor ? "inline" : "action")) === "inline"
      ? "underline"
      : "hover:underline",
    SIZES[size],
    className,
  );
  const content = (
    <>
      {icon}
      {children}
    </>
  );
  if (isLink) {
    const {
      icon: _i,
      size: _s,
      variant: _v,
      className: _c,
      children: _ch,
      ...rest
    } = props as Common & LinkProps;
    return (
      <Link {...rest} className={style}>
        {content}
      </Link>
    );
  }
  if (isAnchor) {
    const {
      icon: _i,
      size: _s,
      variant: _v,
      className: _c,
      children: _ch,
      external,
      ...rest
    } = props as Common & AnchorHTMLAttributes<HTMLAnchorElement> & { external?: boolean };
    return (
      <a {...rest} className={style} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
        {content}
      </a>
    );
  }
  const {
    icon: _i,
    size: _s,
    variant: _v,
    className: _c,
    children: _ch,
    ...rest
  } = props as Common & ButtonHTMLAttributes<HTMLButtonElement>;
  return (
    <button type="button" {...rest} className={style}>
      {content}
    </button>
  );
}
