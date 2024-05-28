import { render } from '@testing-library/react';

import ReactHooks from './react-hooks';

describe('ReactHooks', () => {
  it('should render successfully', () => {
    const { baseElement } = render(<ReactHooks />);
    expect(baseElement).toBeTruthy();
  });
});
