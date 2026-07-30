        tailwind.config = {
            theme: {
                extend: {
                    fontFamily: {
                        sans: ['Outfit', 'sans-serif'],
                        display: ['Space Grotesk', 'sans-serif'],
                    },
                    colors: {
                        cric: {
                            dark: '#09090b',
                            card: '#18181b',
                            panel: '#27272a',
                            green: '#10b981',
                            glow: '#059669',
                            gold: '#fbbf24',
                            accent: '#3b82f6'
                        }
                    },
                    animation: {
                        'pulse-fast': 'pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                        'stamp': 'stamp 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards',
                        'fade-in-up': 'fadeInUp 0.5s ease-out forwards',
                        'fade-in': 'fadeIn 0.3s ease forwards',
                        'float': 'float 6s ease-in-out infinite',
                        'float-up': 'floatUp 2s ease-out forwards',
                    },
                    keyframes: {
                        stamp: {
                            '0%': { opacity: '0', transform: 'scale(3) rotate(-15deg)' },
                            '100%': { opacity: '1', transform: 'scale(1) rotate(-5deg)' }
                        },
                        fadeInUp: {
                            '0%': { opacity: '0', transform: 'translateY(30px)' },
                            '100%': { opacity: '1', transform: 'translateY(0)' }
                        },
                        fadeIn: {
                            '0%': { opacity: '0' },
                            '100%': { opacity: '1' }
                        },
                        float: {
                            '0%, 100%': { transform: 'translateY(0)' },
                            '50%': { transform: 'translateY(-10px)' }
                        },
                        floatUp: {
                            '0%': { transform: 'translateY(0) scale(1)', opacity: '1' },
                            '100%': { transform: 'translateY(-150px) scale(1.5)', opacity: '0' }
                        }
                    }
                }
            }
        }
