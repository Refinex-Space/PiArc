# PiArc terminal: zsh starts here because PiArc pointed ZDOTDIR at this directory. Give the
# user's own startup files back (ZDOTDIR as it was, then their .zshenv), and load PiArc's
# prompt marks for interactive shells. No file of the user's is changed.
if [[ -n "${PIARC_ZDOTDIR+set}" ]]; then
  ZDOTDIR="$PIARC_ZDOTDIR"
else
  unset ZDOTDIR
fi
unset PIARC_ZDOTDIR
if [[ -r "${ZDOTDIR:-$HOME}/.zshenv" ]]; then
  source "${ZDOTDIR:-$HOME}/.zshenv"
fi
if [[ -o interactive && -n "${PIARC_SHELL_INTEGRATION-}" ]]; then
  source "$PIARC_SHELL_INTEGRATION/piarc.zsh"
fi
