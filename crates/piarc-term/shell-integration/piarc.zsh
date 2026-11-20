# PiArc shell integration for zsh. Reports where each prompt, typed command and command
# output begins and how the command ended (OSC 133 A, B, C, D), and the working directory
# (OSC 7), so PiArc can tell commands apart in the terminal it shows. Loaded only by PiArc.
[[ -n "${_PIARC_MARKS-}" ]] && return
typeset -g _PIARC_MARKS=1
typeset -gi _piarc_busy=0

# Percent-encodes $1 into REPLY, byte by byte (UTF-8 stays intact).
_piarc_encode() {
  emulate -L zsh
  setopt extendedglob nomultibyte
  REPLY="${1//(#b)([^A-Za-z0-9._~\/-])/%${(l:2::0:)$(( [##16] #match ))}}"
}

_piarc_precmd() {
  local status_code=$?
  if (( _piarc_busy )); then
    builtin print -rn -- $'\e]133;D;'"$status_code"$'\a'
    _piarc_busy=0
  fi
  _piarc_encode "$PWD"
  builtin print -rn -- $'\e]7;file://'"${HOST}${REPLY}"$'\a'$'\e]133;A\a'
  # Themes rebuild PS1; mark its end again whenever the mark is gone.
  if [[ "$PS1" != *$'\e]133;B'* ]]; then
    PS1="$PS1"$'%{\e]133;B\a%}'
  fi
}

_piarc_preexec() {
  _piarc_encode "$1"
  builtin print -rn -- $'\e]133;C;cmdline_url='"$REPLY"$'\a'
  _piarc_busy=1
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd _piarc_precmd
add-zsh-hook preexec _piarc_preexec
