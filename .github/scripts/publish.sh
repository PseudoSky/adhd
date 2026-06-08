#!/bin/bash
if yarn nx run $1:version --base-branch master; then
  yarn nx run $1:build --with-deps
  # if [ $1 = "utils-data" ]; then
  #   npm publish dist/libs/utils/data
  # elif [ $1 = "utils-testing" ]; then
  #   npm publish dist/libs/utils/testing
  # else
  npm publish dist/packages/$1
  # fi
else
  echo "Failed to version"
fi
