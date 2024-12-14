import { render } from '@testing-library/react';

describe('ReactHooks', () => {
  it('should render successfully', () => {
    const { baseElement } = render(<div />);
    expect(baseElement).toBeTruthy();
  });
});
