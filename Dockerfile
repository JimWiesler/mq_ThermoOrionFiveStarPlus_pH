#use armv7hf compatible base image
FROM balenalib/armv7hf-debian:latest

#dynamic build arguments coming from the /hook/build file
ARG BUILD_DATE
ARG VCS_REF

#metadata labels
LABEL org.label-schema.build-date=$BUILD_DATE \
      org.label-schema.vcs-url="https://github.com/JimWiesler/mqit-kin-netiot-modbustcp-server" \
      org.label-schema.vcs-ref=$VCS_REF

#version
ENV IMAGE_VERSION 0.1.0

#labeling
LABEL maintainer="wiesler@lilly.com" \
      version=$IMAGE_VERSION \
      description="Modbus TCP Server with Watchdog"

#environment variables
# ENV USER=pi
# ENV PASSWD=raspberry

RUN apt-get update \
 && apt-get install wget \
 && wget https://archive.raspbian.org/raspbian.public.key -O - | apt-key add - \
 && echo 'deb http://raspbian.raspberrypi.org/raspbian/ buster main contrib non-free rpi' | tee -a /etc/apt/sources.list \
 && wget -O - http://archive.raspberrypi.org/debian/raspberrypi.gpg.key | sudo apt-key add - \
 && echo 'deb http://archive.raspberrypi.org/debian/ buster main ui' | tee -a /etc/apt/sources.list.d/raspi.list \
 && apt-get update  \
#  && apt-get install -y openssh-server \
#  && mkdir /var/run/sshd \
#  && sed -i 's@#force_color_prompt=yes@force_color_prompt=yes@g' -i /etc/skel/.bashrc \
#  && useradd --create-home --shell /bin/bash pi \
#  && echo $USER:$PASSWD | chpasswd \
#  && adduser $USER sudo \
#  && groupadd spi \
#  && groupadd gpio \
#  && adduser $USER dialout \
#  && adduser $USER cdrom \
#  && adduser $USER audio \
#  && adduser $USER video \
#  && adduser $USER plugdev \
#  && adduser $USER games \
#  && adduser $USER users \
#  && adduser $USER input \
#  && adduser $USER spi \
#  && adduser $USER gpio \
 && apt-get install -y --no-install-recommends \
                apt-utils \
                bash-completion \
                console-setup \
                console-setup-linux \
                # cron \
                # groff-base \
                kbd \
                keyutils \
                # less \
                # logrotate \
                # man-db  \
                # manpages \
                multiarch-support \ 
                # nano \
                # ncurses-term \
                python \
                python3-pip \
                python3-pkg-resources \
                python3-six \
                raspberrypi-kernel \
                raspi-copies-and-fills \
                # rsyslog \
                # screen \
                # ssh \
                tasksel \
                traceroute \
                # alsa-utils \
                # apt-listchanges \
                # apt-transport-https \
                # avahi-daemon \
                # bind9-host \
                # bluez \
                # bsdmainutils \
                # build-essential \
                # cifs-utils \
                # cpio \
                # crda \
                # dc \
                # debconf-i18n \
                # debconf-utils \
                # device-tree-compiler \
                # dhcpcd5 \
                # distro-info-data  \
                # dmidecode \
                # dosfstools \
                # dphys-swapfile \
                # ed \
                # ethtool \
                # fake-hwclock \
                # fakeroot \
                # fbset \
                # file \
                # freetype2-doc \
                # gdb \
                # gdbm-l10n \
                # geoip-database \
                # hardlink \
                # htop \
                # ifupdown \
                # info \
                # init \
                # iptables \
                # iputils-ping \
                # isc-dhcp-client  \
                # isc-dhcp-common  \
                # iso-codes \
                # javascript-common \
                # kmod \
                # libalgorithm-diff-perl \
                # libraspberrypi-bin \
                # libraspberrypi-dev \
                # libraspberrypi-doc \
                # libsigc++-1.2-dev \
                # locales \
                # lsb-release \
                # lua5.1 \
                # luajit \
                # manpages-dev \
                # ncdu \
                # net-tools \
                # netcat-openbsd \
                # netcat-traditional \
                # nfs-common \
                # openresolv \
                # parted \
                # paxctld \
                # pkg-config \
                # policykit-1 \
                # psmisc \
                # publicsuffix \
                # python-rpi.gpio \
                # python3-requests \
                # python3-urllib3 \
                # rfkill \
                # rng-tools \
                # rpcbind \
                # rsync \
                # shared-mime-info \
                # ssh-import-id \
                # strace \
                # triggerhappy \
                # unzip \
                # usb-modeswitch \
                # usb-modeswitch-data \
                # usbutils \
                # v4l-utils \
                # vim-common \
                # vim-tiny \
                # wireless-tools \
                # wpasupplicant \
                # xauth \
                # xdg-user-dirs \
                # xxd \
                # zlib1g-dev:armhf \
#  && mkdir /etc/firmware \
#  && curl -o /etc/firmware/BCM43430A1.hcd -L https://github.com/OpenELEC/misc-firmware/raw/master/firmware/brcm/BCM43430A1.hcd \
#  && wget https://raw.githubusercontent.com/raspberrypi/firmware/1.20180417/opt/vc/bin/vcmailbox -O /opt/vc/bin/vcmailbox \
 && sudo sed -i 's@debian@Raspbian@g' -i /usr/lib/os-release \
 && apt-get remove git \
 && apt-get autoremove \
 && rm -rf /tmp/* \
 && rm -rf /var/lib/apt/lists/*

COPY "requirements.txt" .
RUN pip3 install --upgrade pip
RUN pip3 install -r requirements.txt

#copy files
COPY "./init.d/*" /etc/init.d/
RUN chmod +777 /etc/init.d/entrypoint.sh
ENTRYPOINT ["/etc/init.d/entrypoint.sh"]

#SSH port
# EXPOSE 22

#set STOPSGINAL
STOPSIGNAL SIGTERM

