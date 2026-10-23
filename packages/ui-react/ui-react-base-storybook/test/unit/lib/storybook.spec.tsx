import { render } from '@testing-library/react';

import Storybook from '../../../src/lib/storybook';

describe('Storybook', () => {
  it('should render successfully', () => {
    const { baseElement } = render(<Storybook />);
    expect(baseElement).toBeTruthy();
  });
});
