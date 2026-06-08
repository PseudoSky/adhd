cat <<EOF > ~/.npmrc
email = grepthesky@gmail.com
always-auth = true
@adhd:registry=https://registry.npmjs.org/
@fortawesome:registry=https://npm.fontawesome.com/
//npm.fontawesome.com/:_authToken=900FA3DD-5C0E-4EFB-9CE0-CB8754C5437D

//registry.npmjs.org/:_authToken=${NPM_TOKEN}
EOF
