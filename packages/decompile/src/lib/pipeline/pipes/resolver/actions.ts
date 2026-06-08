type ActionEnum = 'site' | 'local' | 'raw' | 'link' | 'source' | 'map' | 'write'
type ActionType = {
  pipe: 'resolver';
  type: ActionEnum;
  [key: string]: unknown;
}
export const getSiteAction = (props: Partial<ActionType>) => {
  return {
    pipe: 'resolver',
    type: 'site',
    ...props,
  } as ActionType;
};

export const getLocalAction = (props: Partial<ActionType>) => {
  return {
    pipe: 'resolver',
    type: 'local',
    ...props,
  } as ActionType;
};

export const getRawAction = (props: Partial<ActionType>) => {
  return {
    pipe: 'resolver',
    type: 'raw',
    ...props,
  } as ActionType;
};

export const getLinkAction = (props: Partial<ActionType>) => {
  return {
    pipe: 'resolver',
    type: 'link',
    ...props,
  } as ActionType;
};

export const getSourceAction = (props: Partial<ActionType>) => {
  return {
    pipe: 'resolver',
    type: 'source',
    ...props,
  } as ActionType;
};

export const getMapAction = (props: Partial<ActionType>) => {
  return {
    pipe: 'resolver',
    type: 'map',
    ...props,
  } as ActionType;
};

export const getWriteAction = (props: Partial<ActionType>) => {
  return {
    pipe: 'resolver',
    type: 'write',
    ...props,
  } as ActionType;
};
