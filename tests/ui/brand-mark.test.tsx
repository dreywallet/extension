import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BrandMark } from '../../src/ui/components/BrandMark';

afterEach(cleanup);

describe('brand mark', () => {
  it('uses the packaged Drey icon instead of the interim triangle', () => {
    const { container } = render(<BrandMark />);

    expect(screen.getByLabelText('DREY')).toBeInTheDocument();
    expect(container.querySelector('img')).toHaveAttribute('src', '/icon/128.png');
    expect(container.querySelector('img')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('[class*="triangle"]')).not.toBeInTheDocument();
  });
});
