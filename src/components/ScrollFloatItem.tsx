import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

/*
 * Adapted from ReactBits' ScrollFloat.
 *
 * The stock ScrollFloat is a hero-heading effect: it takes a plain string, splits it into
 * per-character spans, forces a huge clamp() font, and renders an <h2>. That breaks on
 * multi-line chat answers (mangled whitespace, oversized text). So we keep ScrollFloat's
 * GSAP float+scale technique but apply it to the whole message block, scoped to the chat's
 * own scroll container (not the window). Each bubble floats up as it scrolls into view.
 */

type Intensity = 'full' | 'subtle';

interface ScrollFloatItemProps {
  children: ReactNode;
  /** The scrollable chat container ScrollTrigger observes (not the window). */
  scrollContainerRef: RefObject<HTMLElement | null>;
  className?: string;
  /** 'full' = fun mode (bigger float + vertical stretch); 'subtle' = professional. */
  intensity?: Intensity;
}

export default function ScrollFloatItem({
  children,
  scrollContainerRef,
  className = '',
  intensity = 'full',
}: ScrollFloatItemProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const scroller = scrollContainerRef.current;
    if (!el || !scroller) return;

    // Fun mode borrows ScrollFloat's stretchy scaleY entrance; professional mode is a
    // restrained fade-and-rise with no distortion.
    const from =
      intensity === 'full'
        ? { opacity: 0, y: 26, scaleY: 1.18, scaleX: 0.96, transformOrigin: '50% 0%' }
        : { opacity: 0, y: 12 };

    const anim = gsap.fromTo(
      el,
      { willChange: 'opacity, transform', ...from },
      {
        opacity: 1,
        y: 0,
        scaleY: 1,
        scaleX: 1,
        duration: intensity === 'full' ? 0.6 : 0.4,
        ease: intensity === 'full' ? 'back.out(1.7)' : 'power2.out',
        scrollTrigger: {
          trigger: el,
          scroller,
          // Play as the bubble rises into view; reverse if it scrolls back out.
          start: 'top bottom-=8%',
          toggleActions: 'play none none reverse',
        },
      },
    );

    return () => {
      anim.scrollTrigger?.kill();
      anim.kill();
    };
  }, [scrollContainerRef, intensity]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
