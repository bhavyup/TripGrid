#!/bin/bash
set -e
# Linux Node lives in ~/opt/node (installed once; SAC blocks the
# Windows-native Rollup binary, so the web build runs in WSL).
if [ ! -x ~/opt/node/bin/node ]; then
  mkdir -p ~/opt
  cd /tmp
  for v in v22.17.0 v22.14.0 v24.11.0; do
    if curl -fsSL -o node.tar.xz "https://nodejs.org/dist/$v/node-$v-linux-x64.tar.xz"; then echo "node $v"; break; fi
  done
  tar -xJf node.tar.xz -C ~/opt
  mv ~/opt/node-* ~/opt/node
fi
export PATH=~/opt/node/bin:$PATH
node -v; npm -v
# Build on the Linux filesystem (drvfs symlinks/permissions fight npm).
rm -rf ~/tripgrid-web
mkdir -p ~/tripgrid-web
cd /mnt/d/codes/tripgrid/web
tar --exclude=node_modules --exclude=dist -cf - . | tar -xf - -C ~/tripgrid-web
cd ~/tripgrid-web
npm install --no-audit --no-fund 2>&1 | tail -2
npm run build 2>&1 | tail -8
rm -rf /mnt/d/codes/tripgrid/web/dist
cp -r dist /mnt/d/codes/tripgrid/web/dist
echo "DIST:"; ls /mnt/d/codes/tripgrid/web/dist
 echo WEB_BUILD_DONE
