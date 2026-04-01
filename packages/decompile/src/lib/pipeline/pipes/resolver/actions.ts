export const getSiteAction = (props) => {
  return {
    pipe: 'resolver',
    type: 'site',
    ...props,
  };
};

export const getLocalAction = (props) => {
  return {
    pipe: 'resolver',
    type: 'local',
    ...props,
  };
};

export const getRawAction = (props) => {
  return {
    pipe: 'resolver',
    type: 'raw',
    ...props,
  };
};

export const getLinkAction = (props) => {
  return {
    pipe: 'resolver',
    type: 'link',
    ...props,
  };
};

export const getSourceAction = (props) => {
  return {
    pipe: 'resolver',
    type: 'source',
    ...props,
  };
};

export const getMapAction = (props) => {
  return {
    pipe: 'resolver',
    type: 'map',
    ...props,
  };
};

export const getWriteAction = (props) => {
  return {
    pipe: 'resolver',
    type: 'write',
    ...props,
  };
};
